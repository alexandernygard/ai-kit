import type { Agent } from "../agent"
import { STRUCTURED_OUTPUT_TOOL } from "../builtin-tools"
import { RAW_PART } from "../context"
import { type Driver, driverLabel, type ModelDriver, type ModelRequest, type ToolChoice } from "../driver"
import type { ToolCallInfo } from "../hooks"
import { createId } from "../id"
import type { ToolPart, ToolRuntime } from "../messages"
import { type Schema, validate } from "../schema"
import { toToolSpec } from "../tools"
import { addUsage, emptyUsage, type Usage } from "../usage"
import { addContext, contextManagement, emitEstimate, emitMeasured, maybeCompact, resolveContext, storeContext, turns } from "./context-window"
import type { RunContext } from "./run-context"
import { assembleTools, systemPrompt } from "./tool-assembly"
import { processCalls, safeTitle } from "./tool-calls"

const DEFAULT_MAX_STEPS = 25

/** Call the model, run its tool calls, and repeat until it stops, suspends or hits a limit. */
export async function runModel(rc: RunContext, driver: ModelDriver) {
  const maxSteps = rc.limits.maxSteps ?? DEFAULT_MAX_STEPS
  let nudgedForOutput = false

  if (rc.input.continueMessage) {
    assembleTools(rc, driver)
    const pending = rc.message.parts.filter(
      (p): p is ToolPart => p.type === "tool" && (p.state === "awaiting-approval" || p.state === "awaiting-output"),
    )
    await processCalls(rc, pending.map((p) => ({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input })), true)
    if (rc.suspended) return rc.end("awaiting-input")
    if (rc.outputSet) return rc.end("stop")
  }

  for (;;) {
    if (rc.signal.aborted) return rc.end(rc.timedOut ? "budget" : "aborted")
    if (rc.step >= maxSteps) return rc.end("max-steps")
    if (rc.overBudget()) return rc.end("budget")

    const { modelTools, hasDeferred, loadedSkills } = assembleTools(rc, driver)
    const contexts = await resolveContext(rc, rc.step)
    storeContext(rc, contexts)
    const system = await systemPrompt(rc, hasDeferred, loadedSkills, driver)
    const choice = toolChoice(rc, driver)
    let request: ModelRequest = {
      system,
      messages: turns(rc, driver),
      tools: modelTools.map((t) => (rc.deferredNames.has(t.name) ? { ...toToolSpec(t), defer: true } : toToolSpec(t))),
      toolChoice: choice,
      responseFormat: rc.outputSchema && rc.nativeOutputNow ? { schema: rc.outputSchema } : undefined,
      settings: { ...rc.agent.settings, ...rc.input.options.settings },
      contextManagement: contextManagement(rc, driver),
      signal: rc.signal,
    }
    if (await maybeCompact(rc, driver, request)) request = { ...request, messages: turns(rc, driver) }
    request = await rc.resolved.hooks.beforeModelCall(request, { ...rc.hookCtx, step: rc.step })

    const stepIndex = rc.step++
    rc.emit({ type: "step-start", step: stepIndex })
    emitEstimate(rc, stepIndex, request, contexts)
    const { calls, finishReason, usage } = await streamStep(rc, driver, request, stepIndex)
    const stepUsage = rc.priced(usage, driver)
    rc.usage = addUsage(rc.usage, stepUsage)
    rc.message = { ...rc.message, usage: rc.usage }
    rc.emit({ type: "step-finish", step: stepIndex, usage: stepUsage, finishReason })
    emitMeasured(rc, stepIndex, usage)
    await rc.resolved.hooks.notify("afterModelCall", { step: stepIndex, finishReason, usage: stepUsage, toolCalls: calls }, rc.hookCtx)

    if (finishReason === "content-filter") return rc.end("content-filter")

    if (!calls.length) {
      if (finishReason === "length") return rc.end("length")
      if (rc.outputSchema && !rc.outputSet) {
        if (rc.nativeOutputNow) {
          const text = stepText(rc, stepIndex)
          const parsed = await parseOutput(rc, text)
          if (parsed.ok) return rc.end("stop")
          if (nudgedForOutput) return rc.fail(`Output didn't match the schema: ${parsed.error}`)
          nudgedForOutput = true
          rc.nudge(`Your answer must be JSON matching the schema. ${parsed.error}`)
          continue
        }
        if (nudgedForOutput) return rc.fail("The model didn't produce structured output.")
        nudgedForOutput = true
        rc.nudge(`Call the ${STRUCTURED_OUTPUT_TOOL} tool with your final answer.`)
        continue
      }
      const more = await rc.resolved.hooks.onStop({ message: rc.message, step: stepIndex }, rc.hookCtx)
      if (more && rc.step < maxSteps) {
        rc.nudge(more)
        continue
      }
      return rc.end("stop")
    }

    await rc.saveMessage()
    await processCalls(rc, calls, false)
    await rc.saveMessage()
    if (rc.signal.aborted) return rc.end(rc.timedOut ? "budget" : "aborted")
    if (rc.suspended) return rc.end("awaiting-input")
    if (rc.outputSet) return rc.end("stop")
  }
}

/**
 * The step's tool choice. Models that reject forced choices get "auto" and a system message
 * naming the tool, stored like other context.
 */
function toolChoice(rc: RunContext, driver: Driver): ToolChoice | undefined {
  const choice = rc.step === 0 && !rc.input.continueMessage ? rc.input.options.toolChoice : undefined
  if (!choice || choice === "auto" || choice === "none" || driver.capabilities?.forcedToolChoice !== false) return choice
  const text = choice === "required" ? "Use one of your tools for this request." : `Use the \`${choice.tool}\` tool for this request.`
  addContext(rc, { name: "tool_choice", role: "system", text })
  return "auto"
}

function stepText(rc: RunContext, step: number) {
  let inStep = false
  let text = ""
  for (const p of rc.message.parts) {
    if (p.type === "step") inStep = p.index === step
    else if (inStep && p.type === "text") text += p.text
  }
  return text
}

async function parseOutput(rc: RunContext, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let value: unknown
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""))
  } catch {
    return { ok: false, error: "It wasn't valid JSON." }
  }
  const v = await validate(rc.outputValidator as Schema, value)
  if (!v.success) return { ok: false, error: v.error }
  rc.output = v.value
  rc.outputSet = true
  return { ok: true }
}

/** Stream one model call, trying fallback models if it fails before producing anything. */
async function streamStep(rc: RunContext, driver: ModelDriver, request: ModelRequest, step: number) {
  const drivers: Agent["model"][] = [driver, ...(rc.agent.fallbackModels ?? [])]
  let lastError: unknown
  for (const d of drivers) {
    const before = rc.message.parts.length
    try {
      return await streamOnce(rc, d, request, step)
    } catch (e) {
      lastError = e
      const produced = rc.message.parts.length > before + 0 && rc.message.parts.slice(before).some((p) => p.type !== "step")
      if (rc.signal.aborted || produced) throw e
      if (d !== drivers.at(-1)) rc.emit({ type: "status", status: "fallback", detail: `Switching to ${driverLabel(drivers[drivers.indexOf(d) + 1]!)}` })
    }
  }
  throw lastError
}

async function streamOnce(rc: RunContext, driver: ModelDriver, request: ModelRequest, step: number) {
  const calls: ToolCallInfo[] = []
  let finishReason: string = "stop"
  let usage: Usage = emptyUsage()
  for await (const e of driver.stream(request)) {
    if (rc.signal.aborted) break
    switch (e.type) {
      case "text-delta":
        if (e.delta) rc.emit({ type: "text-delta", partId: rc.partId(`${step}:t:${e.id}`, "txt"), delta: e.delta })
        break
      case "text-end":
        rc.emit({ type: "text-end", partId: rc.partId(`${step}:t:${e.id}`, "txt") })
        break
      case "reasoning-delta":
        rc.emit({ type: "reasoning-delta", partId: rc.partId(`${step}:r:${e.id}`, "rsn"), delta: e.delta, providerMetadata: e.providerMetadata })
        break
      case "reasoning-end":
        rc.emit({ type: "reasoning-end", partId: rc.partId(`${step}:r:${e.id}`, "rsn"), providerMetadata: e.providerMetadata })
        break
      case "tool-input-start":
        rc.emit({ type: "tool-input-start", toolCallId: e.toolCallId, toolName: e.toolName, runtime: runtimeOf(rc, e.toolName) })
        break
      case "tool-input-delta":
        rc.emit({ type: "tool-input-delta", toolCallId: e.toolCallId, delta: e.delta })
        break
      case "tool-call": {
        const t = rc.tools.get(e.toolName)
        const runtime: ToolRuntime = e.providerExecuted ? "provider" : runtimeOf(rc, e.toolName)
        rc.emit({
          type: "tool-call",
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          input: e.input,
          runtime,
          title: safeTitle(t, e.input),
          providerMetadata: e.providerMetadata,
        })
        if (!e.providerExecuted) calls.push({ toolCallId: e.toolCallId, toolName: e.toolName, input: e.input })
        break
      }
      case "tool-result":
        rc.emit({ type: "tool-result", toolCallId: e.toolCallId, output: e.output, isError: e.isError, providerMetadata: e.providerMetadata })
        break
      case "source":
        rc.emit({ type: "source", part: { type: "source", id: createId("src", 8), url: e.url, title: e.title } })
        break
      case "raw":
        rc.emit({ type: "data", part: { type: "data", id: createId("raw", 8), name: RAW_PART, data: { provider: e.provider, value: e.value } } })
        if (e.compaction) rc.emit({ type: "status", status: "compacted", detail: "The provider summarized the earlier conversation." })
        break
      case "file":
        rc.emit({ type: "file", part: { type: "file", id: createId("file", 8), mediaType: e.mediaType, data: e.data } })
        break
      case "finish":
        finishReason = e.finishReason
        usage = e.usage
        break
      case "error":
        throw e.error instanceof Error ? e.error : new Error(typeof e.error === "string" ? e.error : JSON.stringify(e.error))
    }
  }
  // Close text parts drivers left open.
  for (const p of rc.message.parts) {
    if ((p.type === "text" || p.type === "reasoning") && p.state === "streaming") {
      rc.emit(p.type === "text" ? { type: "text-end", partId: p.id } : { type: "reasoning-end", partId: p.id })
    }
  }
  return { calls, finishReason, usage }
}

function runtimeOf(rc: RunContext, name: string): ToolRuntime {
  return rc.tools.get(name)?.runtime ?? "server"
}
