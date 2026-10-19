import type { AgentEvent, EventEnvelope, FinishReason } from "./events"
import { finalTextOf, type Message, type ToolPart } from "./messages"
import { EventHub, sseResponse } from "./stream"
import type { Usage } from "./usage"

/** How to answer a tool call that's waiting: an approval decision, or a client tool's output. */
export type ToolResponse =
  | {
      approved: boolean
      /** Shown to the model when denying, e.g. "use the staging database instead". */
      message?: string
      /** Run with this input instead (the user edited it). */
      input?: unknown
      /** Allow this tool for the rest of the session. */
      remember?: boolean
    }
  | { output: unknown; isError?: boolean }

export interface RunResult {
  runId: string
  sessionId: string
  message: Message
  /** The final answer's text. */
  text: string
  /** Validated structured output, when an output schema was given. */
  output?: unknown
  finishReason: FinishReason
  usage: Usage
  /** Calls waiting on approvals or client outputs when the run ended with `awaiting-input`. */
  pending: ToolPart[]
  error?: { message: string; code?: string }
}

/**
 * A running (or finished) agent turn. Iterate it for events, await `result` for the outcome.
 *
 * ```ts
 * const run = session.send("Book me a table")
 * for await (const event of run) if (event.type === "text-delta") process.stdout.write(event.delta)
 * const { text, usage } = await run.result
 * ```
 */
export class Run implements AsyncIterable<AgentEvent> {
  readonly result: Promise<RunResult>
  /** @internal */
  readonly hub: EventHub
  /** @internal */
  readonly controller = new AbortController()
  /** @internal */
  readonly waiting = new Map<string, (r: ToolResponse) => void>()
  /** @internal */
  readonly children = new Set<Run>()
  private resolveResult!: (r: RunResult) => void

  constructor(
    readonly id: string,
    readonly sessionId: string,
    readonly agent: string,
  ) {
    this.hub = new EventHub(id)
    this.result = new Promise((r) => (this.resolveResult = r))
  }

  get done() {
    return this.hub.done
  }

  get signal() {
    return this.controller.signal
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for await (const env of this.hub.subscribe()) yield env.event
  }

  /** Events with sequence numbers, starting after `after`. For reconnecting clients. */
  events(after = -1, signal?: AbortSignal): AsyncIterable<EventEnvelope> {
    return this.hub.subscribe(after, signal)
  }

  abort(reason = "aborted") {
    for (const c of this.children) c.abort(reason)
    this.controller.abort(reason)
  }

  /**
   * Answer a call that's waiting in this run or one of its subagents. Returns false when no
   * call with that id is waiting (it may need `session.resume` instead).
   */
  respond(toolCallId: string, response: ToolResponse): boolean {
    const fn = this.waiting.get(toolCallId)
    if (fn) {
      this.waiting.delete(toolCallId)
      fn(response)
      return true
    }
    for (const c of this.children) if (c.respond(toolCallId, response)) return true
    return false
  }

  /** Ids of calls waiting for `respond`, here and in subagents. */
  waitingFor(): string[] {
    return [...this.waiting.keys(), ...[...this.children].flatMap((c) => c.waitingFor())]
  }

  /** Resolves with the final answer's text. */
  async text(): Promise<string> {
    return (await this.result).text
  }

  /** Stream this run as server-sent events. */
  toResponse(init?: ResponseInit & { after?: number }): Response {
    return sseResponse(this.events(init?.after ?? -1), init)
  }

  /** @internal Fail before the runner started (bad session, blocked message). */
  fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const stub: Message = { id: "", role: "assistant", parts: [], parentId: null, createdAt: Date.now(), status: "error" }
    if (!this.hub.done) {
      this.hub.push({ type: "error", error: { message } })
      this.hub.close()
    }
    this.finish({ runId: this.id, sessionId: this.sessionId, message: stub, finishReason: "error", usage: { inputTokens: 0, outputTokens: 0 }, error: { message } })
  }

  /** @internal */
  finish(result: Omit<RunResult, "text" | "pending">) {
    const pending = result.message.parts.filter(
      (p): p is ToolPart => p.type === "tool" && (p.state === "awaiting-approval" || p.state === "awaiting-output"),
    )
    this.resolveResult({ ...result, text: finalTextOf(result.message), pending })
  }
}
