import { STRUCTURED_OUTPUT_TOOL } from "../builtin-tools"
import type { ToolCallInfo } from "../hooks"
import { createId, now } from "../id"
import type { ToolPart } from "../messages"
import { type Schema, validate } from "../schema"
import type { Tool, ToolContext } from "../tools"
import { applyApproval, askApproval, awaitClient, decide } from "./approvals"
import type { RunContext } from "./run-context"

export function toolContext(rc: RunContext, toolCallId: string, toolName: string): ToolContext {
  return {
    toolCallId,
    toolName,
    sessionId: rc.input.session.id,
    runId: rc.run.id,
    agent: rc.agent.name,
    signal: rc.signal,
    context: rc.input.options.context,
    clientContext: rc.input.options.clientContext,
    state: rc.stateAccess(),
    messages: () => rc.path(),
    progress: (data) => rc.emit({ type: "tool-progress", toolCallId, data }),
    emit: (part, o) => rc.emit({ type: "data", part: { type: "data", id: part.id ?? createId("data", 8), name: part.name, data: part.data }, transient: o?.transient }),
    callTool: (name, input) => callNested(rc, name, input, toolCallId),
  }
}

/**
 * Run a step's calls: validate, check permissions, ask, execute. Approved calls run in
 * parallel up to `toolConcurrency`; `sequential` tools run alone.
 */
export async function processCalls(rc: RunContext, calls: ToolCallInfo[], resuming: boolean) {
  const ready: Array<{ call: ToolCallInfo; tool: Tool }> = []
  for (const call of calls) {
    const r = await prepareCall(rc, call, resuming)
    if (r) ready.push(r)
  }
  const limit = Math.max(1, rc.limits.toolConcurrency ?? 8)
  const parallel = ready.filter((r) => !r.tool.sequential)
  const serial = ready.filter((r) => r.tool.sequential)
  let i = 0
  const worker = async () => {
    while (i < parallel.length) {
      const r = parallel[i++]!
      await executeCall(rc, r.call, r.tool)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, parallel.length) }, worker))
  for (const r of serial) await executeCall(rc, r.call, r.tool)
}

/** Returns the call when it should run now; handles everything else (errors, denials, waiting). */
async function prepareCall(rc: RunContext, call: ToolCallInfo, resuming: boolean): Promise<{ call: ToolCallInfo; tool: Tool } | null> {
  const t = rc.tools.get(call.toolName)
  if (!t) {
    rc.emit({
      type: "tool-result",
      toolCallId: call.toolCallId,
      output: `Unknown tool "${call.toolName}". Available: ${rc.exposed.map((x) => x.name).join(", ")}`,
      isError: true,
    })
    return null
  }
  const response = rc.input.responses?.[call.toolCallId]
  const part = rc.message.parts.find((p): p is ToolPart => p.type === "tool" && p.toolCallId === call.toolCallId)

  // A client tool: wait for the browser to run it.
  if (t.runtime === "client") {
    const r = await awaitClient(rc, call, response, resuming && part?.state === "awaiting-output")
    if (r === "pending") return null
    rc.emit({ type: "tool-result", toolCallId: call.toolCallId, output: r.output, isError: r.isError })
    return null
  }

  // Already decided before a suspend.
  if (resuming && part?.state === "awaiting-approval") {
    if (!response) {
      rc.suspended = true
      return null
    }
    return applyApproval(rc, call, t, response)
  }

  // Models always send an object. Anything else is input the driver couldn't parse, and JSON
  // Schema tools have no validator to catch it.
  const v =
    call.input && typeof call.input === "object" && !Array.isArray(call.input)
      ? await validate(t.input as Schema, call.input)
      : { success: false as const, error: "it wasn't a valid JSON object." }
  if (!v.success) {
    rc.emit({ type: "tool-result", toolCallId: call.toolCallId, output: `Invalid input: ${v.error}`, isError: true })
    return null
  }
  const decision = await decide(rc, { ...call, input: v.value }, t)
  const effective = { ...call, input: decision.decision === "allow" && decision.input !== undefined ? decision.input : v.value }
  if (decision.decision === "deny") {
    rc.emit({ type: "tool-result", toolCallId: call.toolCallId, output: decision.reason, isError: true })
    return null
  }
  if (decision.decision === "allow") return { call: effective, tool: t }

  const answer = await askApproval(rc, effective, decision.reason)
  if (answer === "pending") return null
  return applyApproval(rc, effective, t, answer)
}

async function executeCall(rc: RunContext, call: ToolCallInfo, t: Tool) {
  const { output, isError } = await invoke(rc, call, t)
  if (t.name === STRUCTURED_OUTPUT_TOOL && !isError) {
    const v = await validate(rc.outputValidator as Schema, call.input)
    if (v.success) {
      rc.output = v.value
      rc.outputSet = true
    }
  }
  rc.emit({ type: "tool-result", toolCallId: call.toolCallId, output, isError })
}

/** Run a tool's `execute` with timeout, progress, and the after-hooks. */
async function invoke(rc: RunContext, call: ToolCallInfo, t: Tool): Promise<{ output: unknown; isError: boolean }> {
  if (!t.execute) return { output: `${t.name} has no server implementation.`, isError: true }
  rc.emit({ type: "tool-start", toolCallId: call.toolCallId })
  const ctx = toolContext(rc, call.toolCallId, call.toolName)
  const started = now()
  let output: unknown
  let isError = false
  try {
    const exec = async () => {
      const r = t.execute!(call.input, ctx)
      if (r && typeof r === "object" && Symbol.asyncIterator in (r as object)) {
        const it = (r as AsyncIterable<unknown>)[Symbol.asyncIterator]()
        let last: unknown
        for (;;) {
          const n = await it.next()
          if (n.done) return n.value !== undefined ? n.value : last
          last = n.value
          ctx.progress(n.value)
        }
      }
      return r
    }
    output = await withTimeout(exec(), t.timeoutMs, `${t.name} timed out after ${t.timeoutMs} ms`, rc.signal)
  } catch (e) {
    isError = true
    output = e instanceof Error ? e.message : String(e)
  }
  return rc.resolved.hooks.afterToolCall({ ...call, output, isError, durationMs: now() - started }, rc.hookCtx)
}

/** A call made from inside another tool (code mode, `ctx.callTool`). Always waits for approvals. */
export async function callNested(rc: RunContext, name: string, input: unknown, parentToolCallId: string): Promise<unknown> {
  const t = rc.tools.get(name)
  const toolCallId = createId("call")
  rc.emit({ type: "tool-call", toolCallId, toolName: name, input, runtime: t?.runtime ?? "server", title: safeTitle(t, input), parentToolCallId })
  const fail = (msg: string): never => {
    rc.emit({ type: "tool-result", toolCallId, output: msg, isError: true })
    throw new Error(msg)
  }
  if (!t || t.runtime !== "server") return fail(`No server tool named ${name}`)
  const v = await validate(t.input as Schema, input)
  if (!v.success) return fail(`Invalid input for ${name}: ${v.error}`)
  let call: ToolCallInfo = { toolCallId, toolName: name, input: v.value }
  const d = await decide(rc, call, t)
  if (d.decision === "deny") return fail(d.reason)
  if (d.decision === "allow") call = { ...call, input: d.input ?? call.input }
  if (d.decision === "ask") {
    const answer = await askApproval(rc, call, d.reason, true)
    if (answer === "pending") return fail("Approval required.")
    const ok = applyApproval(rc, call, t, answer)
    if (!ok) throw new Error(`The user denied ${name}.`)
    call = ok.call
  }
  const { output, isError } = await invoke(rc, call, t)
  rc.emit({ type: "tool-result", toolCallId, output, isError })
  if (isError) throw new Error(typeof output === "string" ? output : JSON.stringify(output))
  return output
}

export function safeTitle(t: Tool | undefined, input: unknown): string | undefined {
  if (!t?.title) return undefined
  try {
    return t.title(input)
  } catch {
    return undefined
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number | undefined, message: string, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guards: Promise<never>[] = [
    new Promise((_, reject) => {
      if (signal.aborted) reject(new Error("Stopped."))
      signal.addEventListener("abort", () => reject(new Error("Stopped.")), { once: true })
    }),
  ]
  if (ms) guards.push(new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms))))
  try {
    return await Promise.race([p, ...guards])
  } finally {
    clearTimeout(timer)
  }
}
