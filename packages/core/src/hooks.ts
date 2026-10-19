import type { ModelRequest } from "./driver"
import type { AgentEvent, FinishReason } from "./events"
import type { Message } from "./messages"
import type { Usage } from "./usage"

/** What every hook gets. */
export interface HookContext<Ctx = any> {
  sessionId: string
  runId: string
  agent: string
  context: Ctx
  /** What the browser sent with the message. Untrusted. */
  clientContext?: Record<string, unknown>
  /** Run-scoped scratch space shared by hooks. */
  scratch: Map<string, unknown>
}

export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  input: unknown
}

export type ToolDecision =
  | { decision: "allow"; input?: unknown; reason?: string }
  | { decision: "deny"; reason: string }
  | { decision: "ask"; reason?: string }

/**
 * Lifecycle hooks, the same set Claude Code exposes. Return nothing to carry on, or a value to
 * change what happens. Hooks from the kit, plugins and the agent all run, in that order.
 */
export interface Hooks<Ctx = any> {
  /** Change the user message before it's stored, or block it. */
  onUserMessage?(message: Message, ctx: HookContext<Ctx>): void | Message | { block: string } | Promise<void | Message | { block: string }>
  onRunStart?(ctx: HookContext<Ctx>): void | Promise<void>
  /** Edit the request: add context, swap tools, change settings. */
  beforeModelCall?(request: ModelRequest, ctx: HookContext<Ctx> & { step: number }): void | ModelRequest | Promise<void | ModelRequest>
  afterModelCall?(info: { step: number; finishReason: string; usage: Usage; toolCalls: ToolCallInfo[] }, ctx: HookContext<Ctx>): void | Promise<void>
  /** Allow, deny or ask before a tool runs. Can rewrite the input. */
  beforeToolCall?(call: ToolCallInfo, ctx: HookContext<Ctx>): void | ToolDecision | Promise<void | ToolDecision>
  /** Rewrite a tool's output before the model sees it. */
  afterToolCall?(
    call: ToolCallInfo & { output: unknown; isError: boolean; durationMs: number },
    ctx: HookContext<Ctx>,
  ): void | { output: unknown; isError?: boolean } | Promise<void | { output: unknown; isError?: boolean }>
  /**
   * The agent wants to stop. Return `{ continue: "..." }` to send it that message and keep going
   * (for example "the tests still fail"). Capped by `maxSteps`.
   */
  onStop?(info: { message: Message; step: number }, ctx: HookContext<Ctx>): void | { continue: string } | Promise<void | { continue: string }>
  onRunEnd?(info: { finishReason: FinishReason; usage: Usage; message: Message; output?: unknown }, ctx: HookContext<Ctx>): void | Promise<void>
  onEvent?(event: AgentEvent, ctx: HookContext<Ctx>): void
  onError?(error: unknown, ctx: HookContext<Ctx>): void | Promise<void>
  onSubagentStart?(info: { agent: string; sessionId: string; prompt: string }, ctx: HookContext<Ctx>): void | Promise<void>
  onSubagentEnd?(info: { agent: string; sessionId: string; output: unknown }, ctx: HookContext<Ctx>): void | Promise<void>
  /** Before compaction summarises older messages. Return `{ skip: true }` to keep them. */
  beforeCompact?(info: { messages: Message[]; tokens: number }, ctx: HookContext<Ctx>): void | { skip: true } | Promise<void | { skip: true }>
}

/** Run every hook set's handler for `name` in order. */
export class HookRunner<Ctx = any> {
  constructor(private readonly sets: Hooks<Ctx>[]) {}

  get size() {
    return this.sets.length
  }

  async onUserMessage(message: Message, ctx: HookContext<Ctx>): Promise<Message | { block: string }> {
    let cur = message
    for (const h of this.sets) {
      const r = await h.onUserMessage?.(cur, ctx)
      if (r && "block" in r) return r
      if (r) cur = r
    }
    return cur
  }

  async beforeModelCall(req: ModelRequest, ctx: HookContext<Ctx> & { step: number }): Promise<ModelRequest> {
    let cur = req
    for (const h of this.sets) cur = (await h.beforeModelCall?.(cur, ctx)) ?? cur
    return cur
  }

  async beforeToolCall(call: ToolCallInfo, ctx: HookContext<Ctx>): Promise<ToolDecision | undefined> {
    let input = call.input
    let decision: ToolDecision | undefined
    for (const h of this.sets) {
      const r = await h.beforeToolCall?.({ ...call, input }, ctx)
      if (!r) continue
      if (r.decision === "deny") return r
      if (r.decision === "allow" && r.input !== undefined) input = r.input
      // "ask" wins over "allow" from an earlier hook; "deny" wins over both.
      if (!decision || r.decision === "ask") decision = r
    }
    if (decision?.decision === "allow") return { ...decision, input }
    if (decision) return decision
    return input !== call.input ? { decision: "allow", input } : undefined
  }

  async afterToolCall(
    call: ToolCallInfo & { output: unknown; isError: boolean; durationMs: number },
    ctx: HookContext<Ctx>,
  ): Promise<{ output: unknown; isError: boolean }> {
    let cur = { output: call.output, isError: call.isError }
    for (const h of this.sets) {
      const r = await h.afterToolCall?.({ ...call, ...cur }, ctx)
      if (r) cur = { output: r.output, isError: r.isError ?? cur.isError }
    }
    return cur
  }

  async onStop(info: { message: Message; step: number }, ctx: HookContext<Ctx>): Promise<string | undefined> {
    for (const h of this.sets) {
      const r = await h.onStop?.(info, ctx)
      if (r?.continue) return r.continue
    }
    return undefined
  }

  async beforeCompact(info: { messages: Message[]; tokens: number }, ctx: HookContext<Ctx>): Promise<boolean> {
    for (const h of this.sets) if ((await h.beforeCompact?.(info, ctx))?.skip) return false
    return true
  }

  /** Fire-and-collect hooks with no return value. */
  async notify<K extends "onRunStart" | "afterModelCall" | "onRunEnd" | "onError" | "onSubagentStart" | "onSubagentEnd">(
    name: K,
    ...args: Parameters<NonNullable<Hooks<Ctx>[K]>>
  ): Promise<void> {
    for (const h of this.sets) {
      const fn = h[name] as ((...a: unknown[]) => unknown) | undefined
      await fn?.apply(h, args)
    }
  }

  emit(event: AgentEvent, ctx: HookContext<Ctx>) {
    for (const h of this.sets) {
      try {
        h.onEvent?.(event, ctx)
      } catch {
        // onEvent is for observers; a failing observer mustn't break the run.
      }
    }
  }
}
