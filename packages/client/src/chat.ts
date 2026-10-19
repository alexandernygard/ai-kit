import {
  type AgentEvent,
  type ContextUsage,
  type CreateSessionBody,
  createId,
  type EventEnvelope,
  type Message,
  type Part,
  pathTo,
  reduceMessages,
  type SessionInfo,
  siblingsOf,
  textPart,
  type ToolPart,
  type ToolResponse,
} from "@alexandernygard/ai-kit"
import type { RunStream, Transport } from "./transport"

export type ChatStatus =
  /** Nothing running. */
  | "idle"
  /** Loading a session. */
  | "loading"
  /** Sent; waiting for the first event. */
  | "submitted"
  | "streaming"
  /** The agent is waiting on approvals or client tools (see `pending`). */
  | "awaiting-input"
  | "error"

export interface ChatState {
  sessionId: string | null
  session: SessionInfo | null
  /** Every message in the session, all branches. */
  messages: Message[]
  /** Tip of the active branch. */
  headId: string | null
  /** The active branch, oldest first. Render this. */
  path: Message[]
  status: ChatStatus
  error: string | null
  runId: string | null
  /** Tool calls waiting on the user: approvals and client tools without a handler. */
  pending: ToolPart[]
  /** How full the model's context window is, from the latest answer on the active branch. */
  contextUsage: ContextUsage | null
}

/** Runs a client tool in the browser. Return the output; throw to report an error. */
export type ClientToolHandler = (input: any, call: { toolCallId: string; toolName: string }) => unknown | Promise<unknown>

export interface ChatOptions {
  transport: Transport
  /** Open this session. Leave out to start a new one on the first send. */
  sessionId?: string
  /** Agent and title for the session created on the first send. */
  newSession?: CreateSessionBody
  /** Browser-side tools, by name. They run as soon as the agent calls them. */
  clientTools?: Record<string, ClientToolHandler>
  /**
   * Wait until every pending call in a step is answered before resuming (default), so the
   * agent continues once. `false` resumes after each answer.
   */
  batchResponses?: boolean
  /**
   * What the app knows that the agent should too, sent with every message: the current page,
   * the selection, the open document. The server treats it as untrusted; agents see it through
   * the `clientContext()` context provider.
   */
  getContext?: () => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>
  /** Reconnect to a run when the stream drops. Default 3 attempts. */
  reconnectAttempts?: number
  onEvent?: (event: AgentEvent) => void
  onFinish?: (message: Message) => void
  onError?: (error: Error) => void
  /** Called when a new session is created, e.g. to put its id in the URL. */
  onSessionCreated?: (session: SessionInfo) => void
}

const initial = (sessionId: string | null): ChatState => ({
  sessionId,
  session: null,
  messages: [],
  headId: null,
  path: [],
  status: sessionId ? "loading" : "idle",
  error: null,
  runId: null,
  pending: [],
  contextUsage: null,
})

/**
 * A chat bound to one session. Framework-agnostic: `subscribe` follows the Svelte store
 * contract, `getSnapshot` suits React's `useSyncExternalStore`.
 *
 * ```ts
 * const chat = new Chat({ transport: httpTransport(), newSession: { agent: "support" } })
 * chat.subscribe((s) => render(s.path, s.status))
 * await chat.send("Where's my order?")
 * ```
 */
export class Chat {
  private state: ChatState
  private listeners = new Set<(s: ChatState) => void>()
  private controller: AbortController | null = null
  private assistantId: string | null = null
  private lastSeq = -1
  private responses: Record<string, ToolResponse> = {}
  private busy: Promise<void> = Promise.resolve()
  private liveMode = new Map<string, "wait" | "suspend">()
  readonly ready: Promise<void>

  constructor(private readonly options: ChatOptions) {
    this.state = initial(options.sessionId ?? null)
    this.ready = options.sessionId ? this.load(options.sessionId) : Promise.resolve()
  }

  // -------------------------------------------------------------------------------------------
  // Store

  subscribe = (fn: (s: ChatState) => void): (() => void) => {
    this.listeners.add(fn)
    fn(this.state)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): ChatState => this.state

  private set(patch: Partial<ChatState>) {
    const next = { ...this.state, ...patch }
    if (patch.messages || patch.headId !== undefined) {
      next.path = pathTo(next.messages, next.headId)
      next.pending = findPending(next.path.at(-1), this.options.clientTools)
      next.contextUsage = next.path.findLast((m) => m.role === "assistant" && m.contextUsage)?.contextUsage ?? null
    }
    this.state = next
    for (const fn of this.listeners) fn(next)
  }

  // -------------------------------------------------------------------------------------------
  // Sessions

  /** Open a session, and join its run if one is in progress. */
  async load(sessionId: string): Promise<void> {
    this.stopStream()
    this.set({ ...initial(sessionId), status: "loading" })
    try {
      const { session, messages } = await this.options.transport.getSession(sessionId)
      this.set({ session, messages, headId: session.headId, status: statusOf(session, messages), error: null })
      if (session.activeRunId) void this.join(session.activeRunId)
    } catch (e) {
      this.fail(e)
    }
  }

  /** Replace the browser-side tool handlers (frameworks call this when props change). */
  setClientTools(tools: ChatOptions["clientTools"]) {
    this.options.clientTools = tools
  }

  /** Start over with no session; the next send creates one. */
  reset(newSession?: CreateSessionBody) {
    this.stopStream()
    if (newSession) this.options.newSession = newSession
    this.responses = {}
    this.set(initial(null))
  }

  private async ensureSession(): Promise<string> {
    if (this.state.sessionId && this.state.session) return this.state.sessionId
    const session = await this.options.transport.createSession(this.options.newSession)
    this.set({ sessionId: session.id, session })
    this.options.onSessionCreated?.(session)
    return session.id
  }

  // -------------------------------------------------------------------------------------------
  // Sending

  /** Send a message. Resolves when the run ends. */
  send(
    content: string | Part[],
    options: { parentId?: string | null; agent?: string; metadata?: Record<string, unknown>; context?: Record<string, unknown> } = {},
  ): Promise<void> {
    return this.exclusive(async () => {
      const parts = typeof content === "string" ? [textPart(content)] : content
      const optimistic: Message = {
        id: `optimistic_${createId(undefined, 8)}`,
        role: "user",
        parts,
        parentId: options.parentId !== undefined ? options.parentId : this.state.headId,
        createdAt: Date.now(),
        status: "complete",
      }
      this.set({ messages: [...this.state.messages, optimistic], headId: optimistic.id, status: "submitted", error: null })
      const id = await this.ensureSession()
      const clientContext = await this.clientContext(options.context)
      await this.run(() =>
        this.options.transport.send(id, { content: parts, parentId: optimistic.parentId, agent: options.agent, metadata: options.metadata, clientContext }, this.signal()),
        optimistic.id,
      )
    })
  }

  /** Stop the running agent. */
  async stop(): Promise<void> {
    const id = this.state.sessionId
    if (!id) return
    await this.options.transport.abort(id).catch(() => {})
  }

  /** Answer the latest response again; the old one stays as a version. */
  regenerate(messageId?: string): Promise<void> {
    return this.exclusive(async () => {
      const id = await this.ensureSession()
      this.set({ status: "submitted", error: null })
      const clientContext = await this.clientContext()
      await this.run(() => this.options.transport.regenerate(id, { messageId, clientContext }, this.signal()))
    })
  }

  /** Edit a user message. The edit becomes a new branch. */
  edit(messageId: string, content: string | Part[]): Promise<void> {
    return this.exclusive(async () => {
      const id = await this.ensureSession()
      const parts = typeof content === "string" ? [textPart(content)] : content
      this.set({ status: "submitted", error: null })
      const clientContext = await this.clientContext()
      await this.run(() => this.options.transport.send(id, { content: parts, editOf: messageId, clientContext }, this.signal()))
    })
  }

  /** Show another version of a message (the arrows on an edited message). */
  async switchBranch(messageId: string): Promise<void> {
    const id = this.state.sessionId
    if (!id) return
    const { session, messages } = await this.options.transport.branch(id, { messageId })
    this.set({ session, messages, headId: session.headId, status: statusOf(session, messages) })
  }

  /** Where a message sits among its versions, for "2 / 3" pickers. */
  versions(messageId: string): { index: number; total: number; previous?: string; next?: string } {
    const list = siblingsOf(this.state.messages, messageId)
    const index = list.findIndex((m) => m.id === messageId)
    return { index, total: list.length, previous: list[index - 1]?.id, next: list[index + 1]?.id }
  }

  /** Copy the conversation (up to a message) into a new session and open it. */
  async fork(messageId?: string): Promise<string> {
    const id = this.state.sessionId
    if (!id) throw new Error("Nothing to fork yet")
    const { session, messages } = await this.options.transport.fork(id, { messageId })
    this.stopStream()
    this.set({ ...initial(session.id), session, messages, headId: session.headId, status: statusOf(session, messages) })
    this.options.onSessionCreated?.(session)
    return session.id
  }

  // -------------------------------------------------------------------------------------------
  // Answering tool calls

  approve(toolCallId: string, options: { input?: unknown; remember?: boolean } = {}) {
    return this.respond(toolCallId, { approved: true, ...options })
  }

  deny(toolCallId: string, message?: string) {
    return this.respond(toolCallId, { approved: false, message })
  }

  /** Output for a client tool you rendered yourself (a form, a picker). */
  submitToolOutput(toolCallId: string, output: unknown, isError = false) {
    return this.respond(toolCallId, { output, isError })
  }

  /** Answer a pending call. Goes straight to a live run, or batches and resumes. */
  async respond(toolCallId: string, response: ToolResponse): Promise<void> {
    const id = this.state.sessionId
    if (!id) return
    const live = this.liveMode.get(toolCallId) === "wait" && this.controller !== null
    if (live) {
      this.liveMode.delete(toolCallId)
      await this.options.transport.respond(id, { toolCallId, response })
      return
    }
    this.responses[toolCallId] = response
    if (!this.controller) await this.exclusive(() => this.drain())
  }

  /** Answers to send when the run is suspended and (when batching) every pending call has one. */
  private takeResponses(): Record<string, ToolResponse> | null {
    if (this.state.status !== "awaiting-input") return null
    const waiting = pendingIds(this.state.path.at(-1))
    const answered = waiting.filter((w) => this.responses[w])
    if (!answered.length) return null
    if ((this.options.batchResponses ?? true) && answered.length < waiting.length) return null
    const out = Object.fromEntries(answered.map((w) => [w, this.responses[w]!]))
    for (const w of answered) delete this.responses[w]
    return out
  }

  /** Resume with collected answers until nothing is left to send. Runs inside `exclusive`. */
  private async drain(): Promise<void> {
    for (;;) {
      const responses = this.takeResponses()
      if (!responses) return
      const id = this.state.sessionId!
      const clientContext = await this.clientContext()
      await this.consume(() => this.options.transport.resume(id, { responses, clientContext }, this.signal()))
    }
  }

  // -------------------------------------------------------------------------------------------
  // Streams

  private async clientContext(extra?: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const base = await this.options.getContext?.()
    if (!base && !extra) return undefined
    return { ...base, ...extra }
  }

  private exclusive(fn: () => Promise<void>): Promise<void> {
    const next = this.busy.then(fn, fn)
    this.busy = next.catch(() => {})
    return next
  }

  private signal() {
    this.controller = new AbortController()
    return this.controller.signal
  }

  private stopStream() {
    this.controller?.abort()
    this.controller = null
  }

  private join(runId: string) {
    const sessionId = this.state.sessionId!
    this.set({ status: "streaming", runId })
    return this.exclusive(() => this.run(() => this.options.transport.events(runId, { sessionId, after: -1 }, this.signal())))
  }

  private async run(open: () => Promise<RunStream>, optimisticId?: string) {
    await this.consume(open, optimisticId)
    await this.drain()
  }

  private async consume(open: () => Promise<RunStream>, optimisticId?: string) {
    let attempts = 0
    let stream: RunStream
    try {
      stream = await open()
    } catch (e) {
      if (optimisticId) this.set({ messages: this.state.messages.filter((m) => m.id !== optimisticId) })
      this.controller = null
      return this.fail(e)
    }
    let runId = stream.runId
    this.lastSeq = -1
    for (;;) {
      try {
        for await (const env of stream.events) {
          runId = env.runId
          this.handle(env, optimisticId)
        }
        break
      } catch (e) {
        if (this.controller?.signal.aborted) break
        if (!runId || attempts++ >= (this.options.reconnectAttempts ?? 3)) {
          this.controller = null
          return this.fail(e)
        }
        await new Promise((r) => setTimeout(r, 500 * attempts))
        try {
          stream = await this.options.transport.events(runId, { sessionId: this.state.sessionId!, after: this.lastSeq }, this.controller?.signal)
        } catch {}
      }
    }
    this.controller = null
    if (this.state.status === "streaming" || this.state.status === "submitted") this.set({ status: "idle" })
  }

  private handle(env: EventEnvelope, optimisticId?: string) {
    if (env.seq <= this.lastSeq) return
    this.lastSeq = env.seq
    const e = env.event
    if (e.type === "tool-approval-request" || e.type === "tool-awaiting-output") this.liveMode.set(e.toolCallId, e.mode)
    this.options.onEvent?.(e)
    if (e.type === "run-start") {
      this.assistantId = e.message.id
      const messages = optimisticId ? this.state.messages.filter((m) => m.id !== optimisticId) : this.state.messages
      this.set({ messages: reduceMessages(messages, e, undefined), headId: e.message.id, runId: e.runId, status: "streaming" })
      return
    }
    if (e.type === "session-update") {
      if (this.state.session) this.set({ session: { ...this.state.session, ...e.patch, state: { ...this.state.session.state, ...e.patch.state } } })
      return
    }
    const messages = reduceMessages(this.state.messages, e, this.assistantId ?? undefined, { nestSubagents: true })
    if (e.type === "tool-awaiting-output") queueMicrotask(() => this.runClientTool(e.toolCallId))
    if (e.type === "run-finish") {
      const status: ChatStatus = e.finishReason === "awaiting-input" ? "awaiting-input" : e.finishReason === "error" ? "error" : "idle"
      this.set({ messages, status, runId: null, error: status === "error" ? (this.state.error ?? "The agent hit an error.") : null })
      if (status !== "error") this.options.onFinish?.(e.message)
      return
    }
    if (e.type === "error") {
      this.set({ messages, error: e.error.message })
      return
    }
    if (messages !== this.state.messages) this.set({ messages })
  }

  private runClientTool(toolCallId: string) {
    const part = this.state.messages
      .find((m) => m.id === this.assistantId)
      ?.parts.find((p): p is ToolPart => p.type === "tool" && p.toolCallId === toolCallId)
    const handler = part && this.options.clientTools?.[part.toolName]
    if (!part || !handler) return
    void (async () => {
      let response: ToolResponse
      try {
        response = { output: await handler(part.input, { toolCallId, toolName: part.toolName }) }
      } catch (e) {
        response = { output: e instanceof Error ? e.message : String(e), isError: true }
      }
      await this.respond(toolCallId, response)
    })()
  }

  private fail(e: unknown) {
    const error = e instanceof Error ? e : new Error(String(e))
    this.set({ status: "error", error: error.message })
    this.options.onError?.(error)
  }
}

function pendingIds(message: Message | undefined): string[] {
  return (message?.parts ?? [])
    .filter((p): p is ToolPart => p.type === "tool" && (p.state === "awaiting-approval" || p.state === "awaiting-output"))
    .map((p) => p.toolCallId)
}

function findPending(message: Message | undefined, clientTools: ChatOptions["clientTools"]): ToolPart[] {
  return (message?.parts ?? []).filter(
    (p): p is ToolPart =>
      p.type === "tool" && (p.state === "awaiting-approval" || (p.state === "awaiting-output" && !clientTools?.[p.toolName])),
  )
}

function statusOf(session: SessionInfo, messages: Message[]): ChatStatus {
  if (session.activeRunId) return "streaming"
  const head = messages.find((m) => m.id === session.headId)
  return head?.status === "awaiting-input" ? "awaiting-input" : "idle"
}
