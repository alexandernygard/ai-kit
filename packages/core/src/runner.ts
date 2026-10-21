import type { Agent, Limits } from "./agent"
import { askUserTool, STRUCTURED_OUTPUT_TOOL, structuredOutputTool, todoTool } from "./builtin-tools"
import { type CodeModeOptions, runCodeTool } from "./code-mode"
import { COMPACTION_KEY, type CompactionState, estimateRequestTokens, estimateTokens, NUDGE_PART, summarize, toModelTurns } from "./context"
import { ACTIVE_TOOLS_KEY, type DisclosureOptions, searchToolsTool, toolkitsPrompt, type ToolIndexEntry } from "./disclosure"
import {
  type Driver,
  driverLabel,
  type ModelDriver,
  type ModelRequest,
  type ModelSettings,
  type SystemBlock,
  type ToolChoice,
} from "./driver"
import type { AgentEvent, FinishReason } from "./events"
import type { HookContext, HookRunner, ToolCallInfo, ToolDecision } from "./hooks"
import { createId, now } from "./id"
import type { Message, ToolPart, ToolRuntime } from "./messages"
import { checkPermission, type PermissionMode, type Permissions, ruleMatches } from "./permissions"
import { reduceMessage } from "./reducer"
import type { Run, ToolResponse } from "./run"
import { type JSONSchema, type Schema, toJsonSchema, validate } from "./schema"
import { LOADED_SKILLS_KEY, type Skill, skillsPrompt, skillTools } from "./skills"
import type { SessionRecord, Store } from "./store/types"
import { type StateAccess, type Tool, type ToolContext, type Toolkit, toModelOutput, toToolSpec, tool } from "./tools"
import { addUsage, contextWindowFor, costOf, emptyUsage, type ModelPrice, priceFor, type Usage } from "./usage"
import { jsonSchema } from "./schema"
import type { Instructions } from "./agent"
import type { Command } from "./commands"
import { type ContextProvider, renderContext, type ResolvedContext } from "./context-providers"
import type { ContextUsage } from "./events"

export const REMEMBERED_TOOLS_KEY = "ai-kit.allowedTools"

/** An agent with its plugins and kit-wide additions merged in. */
export interface ResolvedAgent<Ctx = any> {
  agent: Agent<Ctx>
  tools: Tool[]
  toolkits: Toolkit[]
  skills: Skill[]
  hooks: HookRunner<Ctx>
  permissions: Permissions<Ctx>
  instructions: Instructions<Ctx>[]
  contextProviders: ContextProvider<Ctx>[]
  commands: Command<Ctx>[]
  subagents: Agent<Ctx>[]
}

export interface RunOptions<Ctx = any> {
  context?: Ctx
  /**
   * What the browser sent with the message: the current page, a selection, the open document.
   * Untrusted. Context providers, tools and hooks can read it; add `clientContext()` to show it
   * to the model.
   */
  clientContext?: Record<string, unknown>
  /** Structured output for this run. */
  output?: Schema | JSONSchema
  settings?: ModelSettings
  permissionMode?: PermissionMode
  /**
   * What happens when a call needs an approval or a client tool's output.
   * - `suspend` (default for model drivers): the run ends with `awaiting-input`; call
   *   `session.resume()` with the answers. Survives restarts and suits serverless.
   * - `wait`: the run pauses in memory until `run.respond()`.
   */
  approvalMode?: "wait" | "suspend"
  /** Decide approvals in code instead of pausing. */
  onToolApproval?: (request: { toolCallId: string; toolName: string; input: unknown; reason?: string }) => ToolResponse | Promise<ToolResponse>
  /** Run client tools in-process (for apps that run the kit in the browser). */
  onClientTool?: (call: { toolCallId: string; toolName: string; input: unknown }) => unknown | Promise<unknown>
  limits?: Limits
  signal?: AbortSignal
  /** Extra tool choice for the first step. */
  toolChoice?: ToolChoice
}

/** What the runner needs from the kit. */
export interface RunnerHost {
  store: Store
  pricing: Record<string, ModelPrice>
  contextWindows: Record<string, number>
  resolve(agentName: string): Promise<ResolvedAgent>
  registerRun(run: Run): void
  unregisterRun(run: Run): void
  createRun(sessionId: string, agent: string): Run
  persistEvents: boolean
  /** Create a child session and run an agent in it. Used for subagents. */
  runChild(params: {
    parent: SessionRecord
    parentToolCallId: string
    agent: string
    prompt: string
    options: RunOptions
  }): Promise<Run>
  autoTitle(session: SessionRecord, userMessage: Message, run: Run): Promise<void>
}

interface RunInput {
  session: SessionRecord
  /** Messages before the assistant message, on the active path. */
  history: Message[]
  /** The new user message; absent when resuming. */
  userMessage?: Message
  /** Assistant message to continue (resume); a new one is created otherwise. */
  continueMessage?: Message
  responses?: Record<string, ToolResponse>
  options: RunOptions
}

const DEFAULT_MAX_STEPS = 25

/** Start a run in the background and return its handle right away. */
export function startRun(host: RunnerHost, resolved: ResolvedAgent, input: RunInput, run: Run): Run {
  const rc = new RunContext(host, resolved, input, run)
  host.registerRun(run)
  void rc.execute().finally(() => host.unregisterRun(run))
  return run
}

class RunContext {
  readonly agent: Agent
  readonly driver: Driver
  message: Message
  private usage: Usage = emptyUsage()
  private step = 0
  private readonly state: Record<string, unknown>
  private stateDirty = false
  private suspended = false
  private output: unknown
  private outputSet = false
  private readonly outputSchema?: JSONSchema
  private readonly outputValidator?: Schema | JSONSchema
  private readonly signal: AbortSignal
  private readonly limits: Limits
  private readonly hookCtx: HookContext
  private readonly pendingEvents: Array<{ seq: number; runId: string; event: AgentEvent }> = []
  private flushTimer?: ReturnType<typeof setTimeout>
  private flushChain: Promise<void> = Promise.resolve()
  private readonly partIds = new Map<string, string>()
  private tools = new Map<string, Tool>()
  private exposed: Tool[] = []
  private timedOut = false
  /** Structured output through the provider's JSON mode (true) or the structured_output tool. */
  private nativeOutputNow = false
  /** Run-scoped context provider results, by name. */
  private runContext = new Map<string, string | undefined>()
  private finishReason: FinishReason = "stop"
  private error?: { message: string; code?: string }

  constructor(
    private readonly host: RunnerHost,
    private readonly resolved: ResolvedAgent,
    private readonly input: RunInput,
    readonly run: Run,
  ) {
    this.agent = resolved.agent
    this.driver = this.agent.model
    this.state = structuredClone(input.session.state ?? {})
    this.limits = { ...this.agent.limits, ...input.options.limits }
    const output = input.options.output ?? this.agent.output
    if (output) {
      this.outputValidator = output
      this.outputSchema = toJsonSchema(output as Schema)
    }
    const signals = [run.signal, input.options.signal].filter((s): s is AbortSignal => !!s)
    this.signal = signals.length > 1 ? AbortSignal.any(signals) : run.signal
    this.hookCtx = {
      sessionId: input.session.id,
      runId: run.id,
      agent: this.agent.name,
      context: input.options.context,
      clientContext: input.options.clientContext,
      scratch: new Map(),
    }
    this.message = input.continueMessage
      ? { ...input.continueMessage, status: "streaming" }
      : {
          id: createId("msg"),
          role: "assistant",
          parts: [],
          parentId: input.userMessage?.id ?? input.history.at(-1)?.id ?? null,
          createdAt: now(),
          agent: this.agent.name,
          model: driverLabel(this.driver),
          status: "streaming",
        }
    if (input.continueMessage) {
      this.step = input.continueMessage.parts.filter((p) => p.type === "step").length
      this.usage = input.continueMessage.usage ?? emptyUsage()
    }
  }

  // ----------------------------------------------------------------------------------------
  // Events and persistence

  emit(event: AgentEvent) {
    this.message = reduceMessage(this.message, event)
    const env = this.run.hub.push(event)
    this.resolved.hooks.emit(event, this.hookCtx)
    if (this.host.persistEvents && this.host.store.appendEvents) {
      this.pendingEvents.push(env)
      this.flushTimer ??= setTimeout(() => void this.flushEvents(), 250)
    }
  }

  /** Write buffered events. Writes are chained so a store's read-modify-write never overlaps. */
  private flushEvents(): Promise<void> {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const batch = this.pendingEvents.splice(0)
    if (batch.length) {
      this.flushChain = this.flushChain.then(() => this.host.store.appendEvents?.(this.run.id, batch)).catch(() => {})
    }
    return this.flushChain
  }

  private async saveMessage() {
    await this.host.store.putMessage(this.input.session.id, this.message)
  }

  private stateAccess(): StateAccess {
    return {
      get: (k) => this.state[k] as never,
      set: (k, v) => {
        this.state[k] = v
        this.stateDirty = true
      },
      delete: (k) => {
        delete this.state[k]
        this.stateDirty = true
      },
    }
  }

  private partId(key: string, prefix: string) {
    let id = this.partIds.get(key)
    if (!id) {
      id = createId(prefix, 10)
      this.partIds.set(key, id)
    }
    return id
  }

  // ----------------------------------------------------------------------------------------
  // Main

  async execute() {
    const { session, userMessage } = this.input
    let timeout: ReturnType<typeof setTimeout> | undefined
    if (this.limits.timeoutMs) {
      timeout = setTimeout(() => {
        this.timedOut = true
        this.run.abort("timeout")
      }, this.limits.timeoutMs)
    }
    try {
      if (userMessage) await this.host.store.putMessage(session.id, userMessage)
      await this.saveMessage()
      await this.host.store.updateSession(session.id, { headId: this.message.id, activeRunId: this.run.id })
      this.emit({
        type: "run-start",
        runId: this.run.id,
        sessionId: session.id,
        agent: this.agent.name,
        userMessage,
        message: this.message,
      })
      await this.resolved.hooks.notify("onRunStart", this.hookCtx)

      await this.runModel(this.driver)
    } catch (e) {
      if (this.signal.aborted) {
        this.finishReason = this.timedOut ? "budget" : "aborted"
      } else {
        this.finishReason = "error"
        this.error = { message: e instanceof Error ? e.message : String(e) }
        this.emit({ type: "error", error: this.error })
        await this.resolved.hooks.notify("onError", e, this.hookCtx).catch(() => {})
      }
    } finally {
      clearTimeout(timeout)
      await this.finalize()
    }
  }

  private async finalize() {
    const reason = this.finishReason
    // Close anything left streaming.
    const parts = this.message.parts.map((p) => {
      if ((p.type === "text" || p.type === "reasoning") && p.state === "streaming") return { ...p, state: "done" as const }
      if (p.type === "tool" && ["input-streaming", "input-available", "running"].includes(p.state)) {
        return { ...p, state: "output-error" as const, error: reason === "aborted" ? "Stopped." : "Didn't finish.", endedAt: now() }
      }
      return p
    })
    const status: Message["status"] =
      reason === "awaiting-input" ? "awaiting-input" : reason === "error" ? "error" : reason === "aborted" ? "aborted" : "complete"
    this.message = { ...this.message, parts, status, usage: this.usage }
    const finalMessage = this.message
    this.emit({ type: "run-finish", finishReason: reason, usage: this.usage, output: this.output, message: finalMessage })
    try {
      await this.saveMessage()
      const patch: Partial<SessionRecord> = { activeRunId: null, headId: this.message.id }
      if (this.stateDirty) patch.state = this.state
      const updated = await this.host.store.updateSession(this.input.session.id, patch)
      if (this.input.userMessage && !updated.title && reason !== "error") {
        await this.host.autoTitle(updated, this.input.userMessage, this.run).catch(() => {})
      }
    } catch (e) {
      this.error ??= { message: e instanceof Error ? e.message : String(e) }
    }
    await this.resolved.hooks
      .notify("onRunEnd", { finishReason: reason, usage: this.usage, message: finalMessage, output: this.output }, this.hookCtx)
      .catch(() => {})
    await this.flushEvents()
    this.run.hub.close()
    this.run.finish({
      runId: this.run.id,
      sessionId: this.input.session.id,
      message: finalMessage,
      output: this.output,
      finishReason: reason,
      usage: this.usage,
      error: this.error,
    })
  }

  // ----------------------------------------------------------------------------------------
  // Tools and system prompt

  /** Work out which tools the model sees this step, and which can be called. */
  private assembleTools(driver: Driver) {
    const r = this.resolved
    const active = new Set((this.state[ACTIVE_TOOLS_KEY] as string[] | undefined) ?? [])
    const loadedSkills = new Set((this.state[LOADED_SKILLS_KEY] as string[] | undefined) ?? [])
    const all: Tool[] = []
    const deferredEntries: ToolIndexEntry[] = []
    const visible: Tool[] = []

    const add = (t: Tool, kit?: Toolkit) => {
      all.push(t)
      const deferred = t.defer || kit?.defer
      if (deferred && !active.has(t.name)) deferredEntries.push({ tool: t, toolkit: kit })
      else visible.push(t)
    }
    r.tools.forEach((t) => add(t))
    r.toolkits.forEach((k) => k.tools.forEach((t) => add(t, k)))
    for (const s of r.skills) {
      if (!loadedSkills.has(s.name)) continue
      for (const t of s.tools ?? []) {
        if (t.kind === "toolkit") t.tools.forEach((x) => (all.push(x), visible.push(x)))
        else (all.push(t), visible.push(t))
      }
    }

    const builtins: Tool[] = []
    if (this.agent.builtins?.askUser) builtins.push(askUserTool())
    if (this.agent.builtins?.todos) builtins.push(todoTool())
    if (r.skills.length) {
      builtins.push(
        ...skillTools(r.skills, (s) => {
          loadedSkills.add(s.name)
          this.stateAccess().set(LOADED_SKILLS_KEY, [...loadedSkills])
        }),
      )
    }
    if (r.subagents.length) builtins.push(this.taskTool())

    const codeMode = this.agent.codeMode
    let modelTools: Tool[]
    if (codeMode) {
      const opts: CodeModeOptions = codeMode === true ? {} : codeMode
      const eligible = (t: Tool) => t.codeMode !== false && t.runtime === "server" && !t.provider && (opts.filter?.(t) ?? true)
      const codeVisible = visible.filter(eligible)
      const codeHidden = deferredEntries.map((e) => e.tool).filter(eligible)
      const direct = opts.keepDirectTools ? visible : visible.filter((t) => !eligible(t))
      const runCode = runCodeTool(codeVisible, codeHidden, (name, input, c) => this.callNested(name, input, c.toolCallId), opts)
      modelTools = [runCode, ...direct, ...builtins]
      const directDeferred = deferredEntries.filter((e) => !eligible(e.tool))
      if (directDeferred.length && this.agent.toolSearch !== false) modelTools.push(this.searchTool(directDeferred, r.toolkits, active))
    } else {
      modelTools = [...visible, ...builtins]
      if (deferredEntries.length && this.agent.toolSearch !== false) modelTools.push(this.searchTool(deferredEntries, r.toolkits, active))
    }

    // Provider JSON mode only works without tools; otherwise answer through a tool.
    this.nativeOutputNow = !!this.outputSchema && this.nativeOutput(driver) && modelTools.length === 0
    if (this.outputSchema && !this.nativeOutputNow) modelTools.push(structuredOutputTool(this.outputSchema))

    this.tools = new Map([...all, ...modelTools].map((t) => [t.name, t]))
    this.exposed = modelTools
    return { modelTools, hasDeferred: deferredEntries.length > 0, loadedSkills }
  }

  private searchTool(entries: ToolIndexEntry[], toolkits: Toolkit[], active: Set<string>) {
    const opts: DisclosureOptions = typeof this.agent.toolSearch === "object" ? this.agent.toolSearch : {}
    return searchToolsTool(
      () => entries,
      toolkits.filter((k) => k.defer),
      (names) => {
        names.forEach((n) => active.add(n))
        this.stateAccess().set(ACTIVE_TOOLS_KEY, [...active])
      },
      opts,
    )
  }

  private nativeOutput(driver: Driver) {
    return driver.capabilities?.structuredOutput === true
  }

  private async systemPrompt(hasDeferred: boolean, loadedSkills: Set<string>, contexts: ResolvedContext[] = []): Promise<SystemBlock[]> {
    const ictx = {
      agent: this.agent.name,
      sessionId: this.input.session.id,
      context: this.input.options.context,
      clientContext: this.input.options.clientContext,
      state: this.state,
    }
    const resolve = async (i: Instructions) => (typeof i === "function" ? await i(ictx) : i)
    const stable: string[] = []
    for (const i of [this.agent.instructions, ...this.resolved.instructions]) {
      if (i) stable.push(await resolve(i))
    }
    const skills = this.resolved.skills
    if (skills.length) stable.push(skillsPrompt(skills))
    const kits = toolkitsPrompt(this.resolved.toolkits, hasDeferred)
    if (kits) stable.push(kits)
    if (this.resolved.subagents.length) {
      stable.push(
        ["# Subagents", "Hand self-contained tasks to a subagent with the `task` tool. Run several at once when they're independent.", ...this.resolved.subagents.map((a) => `- ${a.name}: ${a.description ?? ""}`)].join("\n"),
      )
    }
    const dynamic: string[] = []
    const active = new Set((this.state[ACTIVE_TOOLS_KEY] as string[] | undefined) ?? [])
    for (const k of this.resolved.toolkits) {
      if (k.instructions && (!k.defer || k.tools.some((t) => active.has(t.name)))) dynamic.push(`# ${k.name}\n${k.instructions}`)
    }
    if (this.outputSchema && !this.nativeOutputNow) {
      dynamic.push(`When you're done, call \`${STRUCTURED_OUTPUT_TOOL}\` with your final answer.`)
    }
    void loadedSkills
    for (const c of contexts) if (c.placement === "system") dynamic.push(c.text)
    const blocks: SystemBlock[] = []
    const s = stable.filter(Boolean).join("\n\n")
    if (s) blocks.push({ text: s, cache: true })
    if (dynamic.length) blocks.push({ text: dynamic.join("\n\n") })
    return blocks
  }

  // ----------------------------------------------------------------------------------------
  // Model loop

  private async runModel(driver: ModelDriver) {
    const maxSteps = this.limits.maxSteps ?? DEFAULT_MAX_STEPS
    let nudgedForOutput = false

    if (this.input.continueMessage) {
      this.assembleTools(driver)
      const pending = this.message.parts.filter(
        (p): p is ToolPart => p.type === "tool" && (p.state === "awaiting-approval" || p.state === "awaiting-output"),
      )
      await this.processCalls(pending.map((p) => ({ toolCallId: p.toolCallId, toolName: p.toolName, input: p.input })), true)
      if (this.suspended) return this.end("awaiting-input")
      if (this.outputSet) return this.end("stop")
    }

    for (;;) {
      if (this.signal.aborted) return this.end(this.timedOut ? "budget" : "aborted")
      if (this.step >= maxSteps) return this.end("max-steps")
      if (this.overBudget()) return this.end("budget")

      const { modelTools, hasDeferred, loadedSkills } = this.assembleTools(driver)
      const contexts = await this.resolveContext(this.step)
      const system = await this.systemPrompt(hasDeferred, loadedSkills, contexts)
      let turns = this.turns(contexts)
      let request: ModelRequest = {
        system,
        messages: turns,
        tools: modelTools.map(toToolSpec),
        toolChoice: this.step === 0 && !this.input.continueMessage ? this.input.options.toolChoice : undefined,
        responseFormat: this.outputSchema && this.nativeOutputNow ? { schema: this.outputSchema } : undefined,
        settings: { ...this.agent.settings, ...this.input.options.settings },
        signal: this.signal,
      }
      if (await this.maybeCompact(driver, request)) {
        turns = this.turns(contexts)
        request = { ...request, messages: turns }
      }
      request = await this.resolved.hooks.beforeModelCall(request, { ...this.hookCtx, step: this.step })

      const stepIndex = this.step++
      this.emit({ type: "step-start", step: stepIndex })
      this.emitEstimate(stepIndex, request, contexts)
      const { calls, finishReason, usage } = await this.streamStep(driver, request, stepIndex)
      const stepUsage = this.priced(usage, driver)
      this.usage = addUsage(this.usage, stepUsage)
      this.message = { ...this.message, usage: this.usage }
      this.emit({ type: "step-finish", step: stepIndex, usage: stepUsage, finishReason })
      this.emitMeasured(stepIndex, usage)
      await this.resolved.hooks.notify("afterModelCall", { step: stepIndex, finishReason, usage: stepUsage, toolCalls: calls }, this.hookCtx)

      if (finishReason === "content-filter") return this.end("content-filter")

      if (!calls.length) {
        if (finishReason === "length") return this.end("length")
        if (this.outputSchema && !this.outputSet) {
          if (this.nativeOutputNow) {
            const text = this.stepText(stepIndex)
            const parsed = await this.parseOutput(text)
            if (parsed.ok) return this.end("stop")
            if (nudgedForOutput) return this.fail(`Output didn't match the schema: ${parsed.error}`)
            nudgedForOutput = true
            this.nudge(`Your answer must be JSON matching the schema. ${parsed.error}`)
            continue
          }
          if (nudgedForOutput) return this.fail("The model didn't produce structured output.")
          nudgedForOutput = true
          this.nudge(`Call the ${STRUCTURED_OUTPUT_TOOL} tool with your final answer.`)
          continue
        }
        const more = await this.resolved.hooks.onStop({ message: this.message, step: stepIndex }, this.hookCtx)
        if (more && this.step < maxSteps) {
          this.nudge(more)
          continue
        }
        return this.end("stop")
      }

      await this.saveMessage()
      await this.processCalls(calls, false)
      await this.saveMessage()
      if (this.signal.aborted) return this.end(this.timedOut ? "budget" : "aborted")
      if (this.suspended) return this.end("awaiting-input")
      if (this.outputSet) return this.end("stop")
    }
  }

  private turns(contexts: ResolvedContext[] = []) {
    const path = [...this.input.history, ...(this.input.userMessage ? [this.input.userMessage] : []), this.message]
    const turns = toModelTurns(path, {
      compaction: this.state[COMPACTION_KEY] as CompactionState | undefined,
      clearToolResults: this.agent.compaction === false ? false : this.agent.compaction?.clearToolResults,
      toModelOutput: (name, output) => toModelOutput(this.tools.get(name), output),
    })
    // Turn context goes in front of the newest user message, so earlier turns (and the cache) stay put.
    const inTurn = contexts.filter((c) => c.placement === "turn")
    if (inTurn.length) {
      const i = turns.findLastIndex((t) => t.role === "user")
      const target = turns[i]
      if (target?.role === "user") {
        turns[i] = { role: "user", content: [...inTurn.map((c) => ({ type: "text" as const, text: c.text })), ...target.content] }
      }
    }
    return turns
  }

  // ----------------------------------------------------------------------------------------
  // Context providers and context usage

  /** Run every provider due at this step. Run-scoped results are computed once and reused. */
  private async resolveContext(step: number): Promise<ResolvedContext[]> {
    const providers = this.resolved.contextProviders
    if (!providers.length) return []
    const messages = [...this.input.history, ...(this.input.userMessage ? [this.input.userMessage] : []), this.message]
    const out: ResolvedContext[] = []
    await Promise.all(
      providers.map(async (p) => {
        let text: string | undefined
        if (p.refresh !== "step" && this.runContext.has(p.name)) text = this.runContext.get(p.name)
        else {
          try {
            const value = await p.get({
              agent: this.agent.name,
              sessionId: this.input.session.id,
              context: this.input.options.context,
              clientContext: this.input.options.clientContext,
              state: this.state,
              messages,
              step,
            })
            text = renderContext(p.name, value)
          } catch (e) {
            this.emit({ type: "status", status: "context-error", detail: `${p.name}: ${e instanceof Error ? e.message : String(e)}` })
          }
          if (p.refresh !== "step") this.runContext.set(p.name, text)
        }
        if (text) out.push({ name: p.name, placement: p.placement ?? "turn", text })
      }),
    )
    // Keep the configured order regardless of which provider finished first.
    const order = new Map(providers.map((p, i) => [p.name, i]))
    return out.sort((a, b) => order.get(a.name)! - order.get(b.name)!)
  }

  /** The model's context window: configured, then reported by the driver, then the built-in table. */
  private contextWindow(): number {
    const d = this.driver
    const fromCompaction = this.agent.compaction ? this.agent.compaction.contextWindow : undefined
    return (
      fromCompaction ??
      d.capabilities?.contextWindow ??
      contextWindowFor(d.modelId, this.host.contextWindows) ??
      200_000
    )
  }

  private compactAt(): number | undefined {
    if (this.agent.compaction === false) return undefined
    return this.agent.compaction?.threshold ?? 0.8
  }

  private emitEstimate(step: number, request: ModelRequest, contexts: ResolvedContext[]) {
    const system = estimateTokens(request.system.map((b) => b.text).join("\n"))
    const tools = estimateTokens(request.tools)
    const messages = estimateTokens(request.messages)
    this.emitUsage({
      step,
      tokens: system + tools + messages,
      source: "estimate",
      breakdown: { system, tools, messages, context: contexts.map((c) => ({ name: c.name, tokens: estimateTokens(c.text) })) },
    })
  }

  /** What the provider counted: the whole prompt (cached or not) plus the reply. */
  private emitMeasured(step: number, usage: Usage) {
    const tokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
    if (tokens > 0) this.emitUsage({ step, tokens, source: "provider" })
  }

  private emitUsage(u: Omit<ContextUsage, "window" | "ratio" | "compactAt">) {
    const window = this.contextWindow()
    this.emit({ type: "context-usage", ...u, window, ratio: Math.min(1, u.tokens / window), compactAt: this.compactAt() })
  }

  private stepText(step: number) {
    let inStep = false
    let text = ""
    for (const p of this.message.parts) {
      if (p.type === "step") inStep = p.index === step
      else if (inStep && p.type === "text") text += p.text
    }
    return text
  }

  private async parseOutput(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    let value: unknown
    try {
      value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""))
    } catch {
      return { ok: false, error: "It wasn't valid JSON." }
    }
    const v = await validate(this.outputValidator as Schema, value)
    if (!v.success) return { ok: false, error: v.error }
    this.output = v.value
    this.outputSet = true
    return { ok: true }
  }

  /** Add a user-side message inside the assistant message. It reaches the model as a user turn. */
  private nudge(text: string) {
    this.emit({ type: "data", part: { type: "data", id: createId("nudge", 8), name: NUDGE_PART, data: { text } } })
  }

  private fail(message: string) {
    this.error = { message }
    this.emit({ type: "error", error: this.error })
    return this.end("error")
  }

  private end(reason: FinishReason) {
    this.finishReason = reason
  }

  private overBudget() {
    const l = this.limits
    if (l.maxCostUsd !== undefined && (this.usage.costUsd ?? 0) >= l.maxCostUsd) return true
    if (l.maxTokens !== undefined && this.usage.inputTokens + this.usage.outputTokens >= l.maxTokens) return true
    return false
  }

  private priced(usage: Usage, driver: Driver): Usage {
    if (usage.costUsd !== undefined) return usage
    const cost = costOf(usage, priceFor(driver.modelId, this.host.pricing))
    return cost === undefined ? usage : { ...usage, costUsd: cost }
  }

  /** Stream one model call, trying fallback models if it fails before producing anything. */
  private async streamStep(driver: ModelDriver, request: ModelRequest, step: number) {
    const drivers = [driver, ...(this.agent.fallbackModels ?? [])]
    let lastError: unknown
    for (const d of drivers) {
      const before = this.message.parts.length
      try {
        return await this.streamOnce(d, request, step)
      } catch (e) {
        lastError = e
        const produced = this.message.parts.length > before + 0 && this.message.parts.slice(before).some((p) => p.type !== "step")
        if (this.signal.aborted || produced) throw e
        if (d !== drivers.at(-1)) this.emit({ type: "status", status: "fallback", detail: `Switching to ${driverLabel(drivers[drivers.indexOf(d) + 1]!)}` })
      }
    }
    throw lastError
  }

  private async streamOnce(driver: ModelDriver, request: ModelRequest, step: number) {
    const calls: ToolCallInfo[] = []
    let finishReason: string = "stop"
    let usage: Usage = emptyUsage()
    for await (const e of driver.stream(request)) {
      if (this.signal.aborted) break
      switch (e.type) {
        case "text-delta":
          if (e.delta) this.emit({ type: "text-delta", partId: this.partId(`${step}:t:${e.id}`, "txt"), delta: e.delta })
          break
        case "text-end":
          this.emit({ type: "text-end", partId: this.partId(`${step}:t:${e.id}`, "txt") })
          break
        case "reasoning-delta":
          this.emit({ type: "reasoning-delta", partId: this.partId(`${step}:r:${e.id}`, "rsn"), delta: e.delta, providerMetadata: e.providerMetadata })
          break
        case "reasoning-end":
          this.emit({ type: "reasoning-end", partId: this.partId(`${step}:r:${e.id}`, "rsn"), providerMetadata: e.providerMetadata })
          break
        case "tool-input-start":
          this.emit({ type: "tool-input-start", toolCallId: e.toolCallId, toolName: e.toolName, runtime: this.runtimeOf(e.toolName) })
          break
        case "tool-input-delta":
          this.emit({ type: "tool-input-delta", toolCallId: e.toolCallId, delta: e.delta })
          break
        case "tool-call": {
          const t = this.tools.get(e.toolName)
          const runtime: ToolRuntime = e.providerExecuted ? "provider" : this.runtimeOf(e.toolName)
          this.emit({
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
          this.emit({ type: "tool-result", toolCallId: e.toolCallId, output: e.output, isError: e.isError, providerMetadata: e.providerMetadata })
          break
        case "source":
          this.emit({ type: "source", part: { type: "source", id: createId("src", 8), url: e.url, title: e.title } })
          break
        case "file":
          this.emit({ type: "file", part: { type: "file", id: createId("file", 8), mediaType: e.mediaType, data: e.data } })
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
    for (const p of this.message.parts) {
      if ((p.type === "text" || p.type === "reasoning") && p.state === "streaming") {
        this.emit(p.type === "text" ? { type: "text-end", partId: p.id } : { type: "reasoning-end", partId: p.id })
      }
    }
    return { calls, finishReason, usage }
  }

  private runtimeOf(name: string): ToolRuntime {
    return this.tools.get(name)?.runtime ?? "server"
  }

  private async maybeCompact(driver: ModelDriver, request: ModelRequest): Promise<boolean> {
    const opts = this.agent.compaction
    if (opts === false) return false
    const windowSize = this.contextWindow()
    const threshold = opts?.threshold ?? 0.8
    const tokens = estimateRequestTokens(request)
    if (tokens < windowSize * threshold) return false
    const keep = opts?.keepRecent ?? 6
    const path = [...this.input.history, ...(this.input.userMessage ? [this.input.userMessage] : [])]
    const prev = this.state[COMPACTION_KEY] as CompactionState | undefined
    const start = prev ? path.findIndex((m) => m.id === prev.uptoMessageId) + 1 : 0
    const candidates = path.slice(start, Math.max(start, path.length - keep))
    if (!candidates.length) return false
    if (!(await this.resolved.hooks.beforeCompact({ messages: candidates, tokens }, this.hookCtx))) return false
    this.emit({ type: "status", status: "compacting", detail: `About ${tokens} tokens` })
    const summary = await summarize(opts?.model ?? driver, candidates, { prompt: opts?.prompt, signal: this.signal, previous: prev?.summary })
    const state: CompactionState = { uptoMessageId: candidates.at(-1)!.id, summary }
    this.stateAccess().set(COMPACTION_KEY, state)
    this.emit({ type: "compaction", summary, uptoMessageId: state.uptoMessageId })
    return true
  }

  // ----------------------------------------------------------------------------------------
  // Tool calls

  private toolContext(toolCallId: string, toolName: string): ToolContext {
    return {
      toolCallId,
      toolName,
      sessionId: this.input.session.id,
      runId: this.run.id,
      agent: this.agent.name,
      signal: this.signal,
      context: this.input.options.context,
      clientContext: this.input.options.clientContext,
      state: this.stateAccess(),
      messages: () => [...this.input.history, ...(this.input.userMessage ? [this.input.userMessage] : []), this.message],
      progress: (data) => this.emit({ type: "tool-progress", toolCallId, data }),
      emit: (part, o) => this.emit({ type: "data", part: { type: "data", id: part.id ?? createId("data", 8), name: part.name, data: part.data }, transient: o?.transient }),
      callTool: (name, input) => this.callNested(name, input, toolCallId),
    }
  }

  private approvalMode(): "wait" | "suspend" {
    return this.input.options.approvalMode ?? "suspend"
  }

  /**
   * Run a step's calls: validate, check permissions, ask, execute. Approved calls run in
   * parallel up to `toolConcurrency`; `sequential` tools run alone.
   */
  private async processCalls(calls: ToolCallInfo[], resuming: boolean) {
    const ready: Array<{ call: ToolCallInfo; tool: Tool }> = []
    for (const call of calls) {
      const r = await this.prepareCall(call, resuming)
      if (r) ready.push(r)
    }
    const limit = Math.max(1, this.limits.toolConcurrency ?? 8)
    const parallel = ready.filter((r) => !r.tool.sequential)
    const serial = ready.filter((r) => r.tool.sequential)
    let i = 0
    const worker = async () => {
      while (i < parallel.length) {
        const r = parallel[i++]!
        await this.executeCall(r.call, r.tool)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, parallel.length) }, worker))
    for (const r of serial) await this.executeCall(r.call, r.tool)
  }

  /** Returns the call when it should run now; handles everything else (errors, denials, waiting). */
  private async prepareCall(call: ToolCallInfo, resuming: boolean): Promise<{ call: ToolCallInfo; tool: Tool } | null> {
    const t = this.tools.get(call.toolName)
    if (!t) {
      this.emit({
        type: "tool-result",
        toolCallId: call.toolCallId,
        output: `Unknown tool "${call.toolName}". Available: ${this.exposed.map((x) => x.name).join(", ")}`,
        isError: true,
      })
      return null
    }
    const response = this.input.responses?.[call.toolCallId]
    const part = this.message.parts.find((p): p is ToolPart => p.type === "tool" && p.toolCallId === call.toolCallId)

    // A client tool: wait for the browser to run it.
    if (t.runtime === "client") {
      const r = await this.awaitClient(call, response, resuming && part?.state === "awaiting-output")
      if (r === "pending") return null
      this.emit({ type: "tool-result", toolCallId: call.toolCallId, output: r.output, isError: r.isError })
      return null
    }

    // Already decided before a suspend.
    if (resuming && part?.state === "awaiting-approval") {
      if (!response) {
        this.suspended = true
        return null
      }
      return this.applyApproval(call, t, response)
    }

    // Models always send an object. Anything else is input the driver couldn't parse, and JSON
    // Schema tools have no validator to catch it.
    const v =
      call.input && typeof call.input === "object" && !Array.isArray(call.input)
        ? await validate(t.input as Schema, call.input)
        : { success: false as const, error: "it wasn't a valid JSON object." }
    if (!v.success) {
      this.emit({ type: "tool-result", toolCallId: call.toolCallId, output: `Invalid input: ${v.error}`, isError: true })
      return null
    }
    const decision = await this.decide({ ...call, input: v.value }, t)
    const effective = { ...call, input: decision.decision === "allow" && decision.input !== undefined ? decision.input : v.value }
    if (decision.decision === "deny") {
      this.emit({ type: "tool-result", toolCallId: call.toolCallId, output: decision.reason, isError: true })
      return null
    }
    if (decision.decision === "allow") return { call: effective, tool: t }

    const answer = await this.askApproval(effective, decision.reason)
    if (answer === "pending") return null
    return this.applyApproval(effective, t, answer)
  }

  private applyApproval(call: ToolCallInfo, t: Tool, response: ToolResponse) {
    const approved = "approved" in response ? response.approved : true
    const message = "approved" in response ? response.message : undefined
    this.emit({ type: "tool-approval-response", toolCallId: call.toolCallId, approved, message })
    if (!approved) {
      this.emit({
        type: "tool-result",
        toolCallId: call.toolCallId,
        output: `The user denied this.${message ? ` They said: ${message}` : ""}`,
        isError: true,
      })
      return null
    }
    if ("remember" in response && response.remember) {
      const list = new Set((this.state[REMEMBERED_TOOLS_KEY] as string[] | undefined) ?? [])
      list.add(call.toolName)
      this.stateAccess().set(REMEMBERED_TOOLS_KEY, [...list])
    }
    const input = "approved" in response && response.input !== undefined ? response.input : call.input
    return { call: { ...call, input }, tool: t }
  }

  private async decide(call: ToolCallInfo, t: Tool | undefined): Promise<ToolDecision> {
    const fromHook = await this.resolved.hooks.beforeToolCall(call, this.hookCtx)
    if (fromHook?.decision === "deny" || fromHook?.decision === "ask") return fromHook
    const input = fromHook?.input ?? call.input
    const perms: Permissions = { ...this.resolved.permissions, mode: this.input.options.permissionMode ?? this.resolved.permissions.mode }
    // A hook's explicit allow skips the prompt, like Claude Code's PreToolUse. Deny rules still win.
    if (fromHook?.decision === "allow") {
      if ((perms.deny ?? []).some((r) => ruleMatches(r, call.toolName, input, t))) return { decision: "deny", reason: `${call.toolName} is not allowed here.` }
      return { decision: "allow", input }
    }
    const remembered = (this.state[REMEMBERED_TOOLS_KEY] as string[] | undefined) ?? []
    const d = await checkPermission(perms, { toolName: call.toolName, input, tool: t }, this.toolContext(call.toolCallId, call.toolName), remembered)
    if (d.decision === "allow") return { ...d, input }
    return d
  }

  /** Ask for approval. Resolves with the answer, or "pending" when the run suspends. */
  private async askApproval(call: ToolCallInfo, reason: string | undefined, forceWait = false): Promise<ToolResponse | "pending"> {
    const handler = this.input.options.onToolApproval
    const mode = forceWait || handler ? "wait" : this.approvalMode()
    this.emit({ type: "tool-approval-request", toolCallId: call.toolCallId, reason, mode })
    if (handler) return handler({ ...call, reason })
    if (mode === "suspend") {
      this.suspended = true
      return "pending"
    }
    return this.waitFor(call.toolCallId)
  }

  private async awaitClient(
    call: ToolCallInfo,
    response: ToolResponse | undefined,
    wasWaiting: boolean,
  ): Promise<{ output: unknown; isError?: boolean } | "pending"> {
    if (response && "output" in response) return response
    if (response && "approved" in response && !response.approved) {
      return { output: `The user dismissed this.${response.message ? ` They said: ${response.message}` : ""}`, isError: true }
    }
    const handler = this.input.options.onClientTool
    if (handler) {
      this.emit({ type: "tool-awaiting-output", toolCallId: call.toolCallId, mode: "wait" })
      try {
        return { output: await handler(call) }
      } catch (e) {
        return { output: e instanceof Error ? e.message : String(e), isError: true }
      }
    }
    const mode = this.approvalMode()
    if (!wasWaiting || mode === "wait") this.emit({ type: "tool-awaiting-output", toolCallId: call.toolCallId, mode })
    if (mode === "suspend") {
      this.suspended = true
      return "pending"
    }
    const r = await this.waitFor(call.toolCallId)
    if ("output" in r) return r
    return { output: r.approved ? (r.message ?? "") : `The user dismissed this.${r.message ? ` They said: ${r.message}` : ""}`, isError: !r.approved }
  }

  private waitFor(toolCallId: string): Promise<ToolResponse> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) return reject(new Error("Aborted"))
      this.run.waiting.set(toolCallId, resolve)
      this.signal.addEventListener(
        "abort",
        () => {
          this.run.waiting.delete(toolCallId)
          reject(new Error("Aborted"))
        },
        { once: true },
      )
    })
  }

  private async executeCall(call: ToolCallInfo, t: Tool) {
    const { output, isError } = await this.invoke(call, t)
    if (t.name === STRUCTURED_OUTPUT_TOOL && !isError) {
      const v = await validate(this.outputValidator as Schema, call.input)
      if (v.success) {
        this.output = v.value
        this.outputSet = true
      }
    }
    this.emit({ type: "tool-result", toolCallId: call.toolCallId, output, isError })
  }

  /** Run a tool's `execute` with timeout, progress, and the after-hooks. */
  private async invoke(call: ToolCallInfo, t: Tool): Promise<{ output: unknown; isError: boolean }> {
    if (!t.execute) return { output: `${t.name} has no server implementation.`, isError: true }
    this.emit({ type: "tool-start", toolCallId: call.toolCallId })
    const ctx = this.toolContext(call.toolCallId, call.toolName)
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
      output = await withTimeout(exec(), t.timeoutMs, `${t.name} timed out after ${t.timeoutMs} ms`, this.signal)
    } catch (e) {
      isError = true
      output = e instanceof Error ? e.message : String(e)
    }
    return this.resolved.hooks.afterToolCall({ ...call, output, isError, durationMs: now() - started }, this.hookCtx)
  }

  /** A call made from inside another tool (code mode, `ctx.callTool`). Always waits for approvals. */
  private async callNested(name: string, input: unknown, parentToolCallId: string): Promise<unknown> {
    const t = this.tools.get(name)
    const toolCallId = createId("call")
    this.emit({ type: "tool-call", toolCallId, toolName: name, input, runtime: t?.runtime ?? "server", title: safeTitle(t, input), parentToolCallId })
    const fail = (msg: string): never => {
      this.emit({ type: "tool-result", toolCallId, output: msg, isError: true })
      throw new Error(msg)
    }
    if (!t || t.runtime !== "server") return fail(`No server tool named ${name}`)
    const v = await validate(t.input as Schema, input)
    if (!v.success) return fail(`Invalid input for ${name}: ${v.error}`)
    let call: ToolCallInfo = { toolCallId, toolName: name, input: v.value }
    const d = await this.decide(call, t)
    if (d.decision === "deny") return fail(d.reason)
    if (d.decision === "allow") call = { ...call, input: d.input ?? call.input }
    if (d.decision === "ask") {
      const answer = await this.askApproval(call, d.reason, true)
      if (answer === "pending") return fail("Approval required.")
      const ok = this.applyApproval(call, t, answer)
      if (!ok) throw new Error(`The user denied ${name}.`)
      call = ok.call
    }
    const { output, isError } = await this.invoke(call, t)
    this.emit({ type: "tool-result", toolCallId, output, isError })
    if (isError) throw new Error(typeof output === "string" ? output : JSON.stringify(output))
    return output
  }

  // ----------------------------------------------------------------------------------------
  // Subagents

  private taskTool(): Tool {
    const agents = this.resolved.subagents
    const names = agents.map((a) => a.name)
    return tool({
      name: "task",
      description: `Give a self-contained task to a subagent. It works in its own context and returns its final answer. Include everything it needs in the prompt. Agents: ${agents.map((a) => `${a.name} (${a.description ?? "no description"})`).join("; ")}`,
      input: jsonSchema<{ agent: string; prompt: string; description?: string }>({
        type: "object",
        properties: {
          agent: { type: "string", enum: names },
          description: { type: "string", description: "3-5 words for the UI" },
          prompt: { type: "string", description: "The full task" },
        },
        required: ["agent", "prompt"],
      }),
      codeMode: false,
      title: (i) => i.description ?? `Asking ${i.agent}`,
      execute: async ({ agent, prompt }, ctx) => {
        const parent = await this.host.store.getSession(this.input.session.id)
        if (!parent) throw new Error("Session disappeared")
        await this.resolved.hooks.notify("onSubagentStart", { agent, sessionId: "", prompt }, this.hookCtx)
        const child = await this.host.runChild({
          parent,
          parentToolCallId: ctx.toolCallId,
          agent,
          prompt,
          options: {
            context: this.input.options.context,
            clientContext: this.input.options.clientContext,
            approvalMode: "wait",
            onToolApproval: this.input.options.onToolApproval,
            permissionMode: this.input.options.permissionMode,
            signal: this.signal,
          },
        })
        this.run.children.add(child)
        this.emit({ type: "tool-child-session", toolCallId: ctx.toolCallId, sessionId: child.sessionId })
        try {
          for await (const ev of child) this.emit({ type: "subagent", toolCallId: ctx.toolCallId, sessionId: child.sessionId, event: ev })
          const result = await child.result
          this.usage = addUsage(this.usage, result.usage)
          await this.resolved.hooks.notify("onSubagentEnd", { agent, sessionId: child.sessionId, output: result.output ?? result.text }, this.hookCtx)
          if (result.finishReason === "error") throw new Error(result.error?.message ?? "Subagent failed")
          if (result.finishReason === "aborted") throw new Error("Subagent was stopped")
          return result.output !== undefined ? result.output : result.text || "(no answer)"
        } finally {
          this.run.children.delete(child)
        }
      },
    })
  }
}

function safeTitle(t: Tool | undefined, input: unknown): string | undefined {
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
