import type { Agent, Limits } from "../agent"
import { type Driver, driverLabel } from "../driver"
import type { AgentEvent, FinishReason } from "../events"
import type { HookContext } from "../hooks"
import { createId, now } from "../id"
import { closeOpenParts, type Message } from "../messages"
import { NUDGE_PART } from "../context"
import { reduceMessage } from "../reducer"
import type { Run } from "../run"
import type { ResolvedAgent, RunInput, RunnerHost } from "../runner"
import { type JSONSchema, type Schema, toJsonSchema } from "../schema"
import type { SessionRecord } from "../store/types"
import type { StateAccess, Tool } from "../tools"
import { costOf, emptyUsage, priceFor, type Usage } from "../usage"
import { runModel } from "./step-loop"

/** One run's state and lifecycle. The other runner modules work on it. */
export class RunContext {
  readonly agent: Agent
  readonly driver: Driver
  message: Message
  usage: Usage = emptyUsage()
  step = 0
  readonly state: Record<string, unknown>
  private stateDirty = false
  suspended = false
  output: unknown
  outputSet = false
  readonly outputSchema?: JSONSchema
  readonly outputValidator?: Schema | JSONSchema
  readonly signal: AbortSignal
  readonly limits: Limits
  readonly hookCtx: HookContext
  private readonly pendingEvents: Array<{ seq: number; runId: string; event: AgentEvent }> = []
  private flushTimer?: ReturnType<typeof setTimeout>
  private flushChain: Promise<void> = Promise.resolve()
  private leaseTimer?: ReturnType<typeof setInterval>
  private leaseChain: Promise<unknown> = Promise.resolve()
  private readonly partIds = new Map<string, string>()
  /** Every tool callable this step, by name. */
  tools = new Map<string, Tool>()
  /** The tools the model was shown this step. */
  exposed: Tool[] = []
  /** Tools to send with `defer: true`, for drivers that search tools themselves. */
  deferredNames = new Set<string>()
  timedOut = false
  /** Structured output through the provider's JSON mode (true) or the structured_output tool. */
  nativeOutputNow = false
  /** Run-scoped context provider results, by name. */
  readonly runContext = new Map<string, string | undefined>()
  private finishReason: FinishReason = "stop"
  error?: { message: string; code?: string }

  constructor(
    readonly host: RunnerHost,
    readonly resolved: ResolvedAgent,
    readonly input: RunInput,
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

  async saveMessage() {
    await this.host.store.putMessage(this.input.session.id, this.message)
  }

  stateAccess(): StateAccess {
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

  partId(key: string, prefix: string) {
    let id = this.partIds.get(key)
    if (!id) {
      id = createId(prefix, 10)
      this.partIds.set(key, id)
    }
    return id
  }

  /** The conversation so far: history, the new user message and the message being written. */
  path(): Message[] {
    return [...this.input.history, ...(this.input.userMessage ? [this.input.userMessage] : []), this.message]
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
      await this.host.store.updateSession(session.id, { headId: this.message.id, activeRunId: this.run.id, activeRunLeaseUntil: now() + this.host.runLeaseMs })
      this.startLease()
      this.emit({
        type: "run-start",
        runId: this.run.id,
        sessionId: session.id,
        agent: this.agent.name,
        userMessage,
        message: this.message,
      })
      await this.resolved.hooks.notify("onRunStart", this.hookCtx)

      await runModel(this, this.driver)
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
    await this.stopLease()
    const parts = closeOpenParts(this.message.parts, reason === "aborted" ? "Stopped." : "Didn't finish.")
    const status: Message["status"] =
      reason === "awaiting-input" ? "awaiting-input" : reason === "error" ? "error" : reason === "aborted" ? "aborted" : "complete"
    this.message = { ...this.message, parts, status, usage: this.usage }
    const finalMessage = this.message
    this.emit({ type: "run-finish", finishReason: reason, usage: this.usage, output: this.output, message: finalMessage })
    try {
      await this.saveMessage()
      const patch: Partial<SessionRecord> = { activeRunId: null, activeRunLeaseUntil: null, headId: this.message.id }
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

  /**
   * Renew the session's lease a few times per lease period so other processes can tell this
   * run is alive. Renewals are chained, and `stopLease` waits for the last one, so a renewal
   * never lands after `finalize` clears the active run.
   */
  private startLease() {
    const lease = this.host.runLeaseMs
    this.leaseTimer = setInterval(() => {
      this.leaseChain = this.leaseChain
        .then(() => this.host.store.updateSession(this.input.session.id, { activeRunLeaseUntil: now() + lease }))
        .catch(() => {})
    }, Math.max(lease / 3, 100))
  }

  private stopLease() {
    clearInterval(this.leaseTimer)
    return this.leaseChain
  }

  // ----------------------------------------------------------------------------------------
  // Ending and steering

  /** Add a user-side message inside the assistant message. It reaches the model as a user turn. */
  nudge(text: string) {
    this.emit({ type: "data", part: { type: "data", id: createId("nudge", 8), name: NUDGE_PART, data: { text } } })
  }

  fail(message: string) {
    this.error = { message }
    this.emit({ type: "error", error: this.error })
    return this.end("error")
  }

  end(reason: FinishReason) {
    this.finishReason = reason
  }

  overBudget() {
    const l = this.limits
    if (l.maxCostUsd !== undefined && (this.usage.costUsd ?? 0) >= l.maxCostUsd) return true
    if (l.maxTokens !== undefined && this.usage.inputTokens + this.usage.outputTokens >= l.maxTokens) return true
    return false
  }

  priced(usage: Usage, driver: Driver): Usage {
    if (usage.costUsd !== undefined) return usage
    const cost = costOf(usage, priceFor(driver.modelId, this.host.pricing))
    return cost === undefined ? usage : { ...usage, costUsd: cost }
  }
}
