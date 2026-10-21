import { expandCommand } from "./commands"
import { COMPACTION_KEY, summarize } from "./context"
import { createId } from "./id"
import type { Kit } from "./kit"
import { leafOf, type Message, pathTo, siblingsOf, type UserContent, userMessage } from "./messages"
import type { Run, ToolResponse } from "./run"
import { type RunOptions, startRun } from "./runner"
import type { SessionRecord } from "./store/types"

export interface SendOptions<Ctx = any> extends RunOptions<Ctx> {
  /** Reply to this message instead of the head; creates a branch. `null` starts from the top. */
  parentId?: string | null
  /** Answer with another agent this turn (the session keeps its agent). */
  agent?: string
  /** Stop the session's active run first instead of failing. */
  interrupt?: boolean
  /** Stored on the user message. */
  metadata?: Record<string, unknown>
  /** Send as an edit of this user message (a sibling branch). `session.edit` sets it. */
  editOf?: string
}

export interface ForkOptions {
  /** Copy messages up to this one. Default: the head. */
  messageId?: string | null
  title?: string
  metadata?: Record<string, unknown>
}

/**
 * A conversation with an agent. Messages form a tree, so edits and regenerations create
 * branches you can switch between, and `fork` copies a conversation into a new session.
 */
export class Session<Ctx = any> {
  constructor(
    private readonly kit: Kit<Ctx>,
    private rec: SessionRecord,
  ) {}

  get id() {
    return this.rec.id
  }
  get agent() {
    return this.rec.agent
  }
  get title() {
    return this.rec.title
  }
  get headId() {
    return this.rec.headId
  }
  /** The stored record as of the last load. */
  get record(): SessionRecord {
    return this.rec
  }

  async refresh(): Promise<this> {
    const r = await this.kit.store.getSession(this.id)
    if (!r) throw new Error(`Session ${this.id} was deleted`)
    this.rec = r
    return this
  }

  /** Every message, all branches. */
  messages(): Promise<Message[]> {
    return this.kit.store.getMessages(this.id)
  }

  /** Messages on the active branch, oldest first. */
  async history(): Promise<Message[]> {
    await this.refresh()
    return pathTo(await this.messages(), this.rec.headId)
  }

  /** The run in progress, if any (in this process). */
  activeRun(): Run | undefined {
    return this.rec.activeRunId ? this.kit.getRun(this.rec.activeRunId) : undefined
  }

  /** Send a user message and run the agent. Returns immediately; iterate or await the run. */
  send(content: UserContent, options: SendOptions<Ctx> = {}): Run {
    const agentName = options.agent ?? this.rec.agent
    const run = this.kit.createRun(this.id, agentName)
    void (async () => {
      const rec = await this.prepare(run, options)
      const resolved = await this.kit.resolve(agentName)
      const all = await this.messages()
      const editOf = options.editOf
      let parentId = options.parentId !== undefined ? options.parentId : rec.headId
      if (editOf) {
        const target = all.find((m) => m.id === editOf)
        if (!target || target.role !== "user") throw new Error("Only user messages can be edited.")
        parentId = target.parentId
      }
      const history = pathTo(all, parentId)
      let msg = userMessage(content, parentId)
      if (options.metadata) msg.metadata = { ...msg.metadata, ...options.metadata }
      const expanded = await expandCommand(msg, resolved.commands, { context: options.context as Ctx, sessionId: this.id })
      msg = expanded.message
      const hookCtx = { sessionId: this.id, runId: run.id, agent: agentName, context: options.context as Ctx, scratch: new Map() }
      const checked = await resolved.hooks.onUserMessage(msg, hookCtx)
      if ("block" in checked) throw new Error(checked.block)
      startRun(this.kit.host, resolved, { session: rec, history, userMessage: checked, options }, run)
    })().catch((e) => this.failRun(run, e))
    return run
  }

  /**
   * Continue a run that ended with `awaiting-input`, answering its pending calls by id.
   * Calls you don't answer stay pending.
   */
  resume(responses: Record<string, ToolResponse>, options: Omit<SendOptions<Ctx>, "parentId"> = {}): Run {
    const run = this.kit.createRun(this.id, options.agent ?? this.rec.agent)
    void (async () => {
      const rec = await this.prepare(run, options)
      const all = await this.messages()
      const path = pathTo(all, rec.headId)
      const last = path.at(-1)
      if (!last || last.role !== "assistant" || last.status !== "awaiting-input") {
        throw new Error("Nothing to resume: the last message isn't waiting for input.")
      }
      const agentName = options.agent ?? last.agent ?? rec.agent
      const resolved = await this.kit.resolve(agentName)
      startRun(this.kit.host, resolved, { session: rec, history: path.slice(0, -1), continueMessage: last, responses, options }, run)
    })().catch((e) => this.failRun(run, e))
    return run
  }

  /**
   * Answer a waiting call. Goes to the live run when it's waiting in memory, otherwise resumes
   * the session. Returns the run that will continue.
   */
  respond(toolCallId: string, response: ToolResponse, options: Omit<SendOptions<Ctx>, "parentId"> = {}): Run {
    const active = this.activeRun()
    if (active && active.respond(toolCallId, response)) return active
    return this.resume({ [toolCallId]: response }, options)
  }

  /** Edit a user message: the edit becomes a sibling branch and the agent answers it. */
  edit(messageId: string, content: UserContent, options: Omit<SendOptions<Ctx>, "parentId"> = {}): Run {
    return this.send(content, { ...options, editOf: messageId })
  }

  /** Answer again from the same point. The new answer is a sibling of the old one. */
  regenerate(assistantMessageId?: string, options: Omit<SendOptions<Ctx>, "parentId"> = {}): Run {
    const run = this.kit.createRun(this.id, options.agent ?? this.rec.agent)
    void (async () => {
      const rec = await this.prepare(run, options)
      const all = await this.messages()
      const targetId = assistantMessageId ?? rec.headId
      const target = all.find((m) => m.id === targetId)
      const userId = target?.role === "assistant" ? target.parentId : target?.id
      if (!userId) throw new Error("Nothing to regenerate.")
      const history = pathTo(all, userId)
      const agentName = options.agent ?? target?.agent ?? rec.agent
      const resolved = await this.kit.resolve(agentName)
      startRun(this.kit.host, resolved, { session: rec, history, options }, run)
    })().catch((e) => this.failRun(run, e))
    return run
  }

  /** Versions of a message: the original and its edits or regenerations. */
  async versions(messageId: string): Promise<Message[]> {
    return siblingsOf(await this.messages(), messageId)
  }

  /** Make the branch through `messageId` active. Its newest leaf becomes the head. */
  async switchBranch(messageId: string): Promise<void> {
    const all = await this.messages()
    if (!all.some((m) => m.id === messageId)) throw new Error(`No message ${messageId}`)
    this.rec = await this.kit.store.updateSession(this.id, { headId: leafOf(all, messageId) })
  }

  /** Copy the conversation (up to `messageId`) into a new session. */
  async fork(options: ForkOptions = {}): Promise<Session<Ctx>> {
    await this.refresh()
    const all = await this.messages()
    const upto = options.messageId === undefined ? this.rec.headId : options.messageId
    const path = pathTo(all, upto)
    const ids = new Map<string, string>()
    for (const m of path) ids.set(m.id, createId("msg"))
    const state = { ...this.rec.state }
    delete state[COMPACTION_KEY]
    const child = await this.kit.createSession({
      agent: this.rec.agent,
      ownerId: this.rec.ownerId,
      title: options.title ?? (this.rec.title ? `${this.rec.title} (fork)` : undefined),
      metadata: { ...this.rec.metadata, ...options.metadata },
      state,
      forkedFrom: { sessionId: this.id, messageId: upto ?? null },
    })
    for (const m of path) {
      await this.kit.store.putMessage(child.id, {
        ...m,
        id: ids.get(m.id)!,
        parentId: m.parentId ? (ids.get(m.parentId) ?? null) : null,
        status: m.status === "streaming" ? "aborted" : m.status,
      })
    }
    const head = upto ? (ids.get(upto) ?? null) : null
    await this.kit.store.updateSession(child.id, { headId: head })
    return child.refresh()
  }

  /** Summarise older messages now instead of waiting for the context to fill. */
  async compact(options: { keepRecent?: number; signal?: AbortSignal } = {}): Promise<string | null> {
    const resolved = await this.kit.resolve(this.rec.agent)
    const driver = resolved.agent.compaction ? resolved.agent.compaction.model : undefined
    const model = driver ?? resolved.agent.model
    const path = await this.history()
    const keep = options.keepRecent ?? 4
    const candidates = path.slice(0, Math.max(0, path.length - keep))
    if (!candidates.length) return null
    const summary = await summarize(model, candidates, { signal: options.signal ?? new AbortController().signal })
    this.rec = await this.kit.store.updateSession(this.id, {
      state: { ...this.rec.state, [COMPACTION_KEY]: { uptoMessageId: candidates.at(-1)!.id, summary } },
    })
    return summary
  }

  async update(patch: { title?: string; metadata?: Record<string, unknown>; agent?: string }): Promise<this> {
    this.rec = await this.kit.store.updateSession(this.id, patch)
    return this
  }

  /** Read or write session state (the same state tools see). */
  async setState(key: string, value: unknown): Promise<void> {
    await this.refresh()
    this.rec = await this.kit.store.updateSession(this.id, { state: { ...this.rec.state, [key]: value } })
  }

  async delete(): Promise<void> {
    this.activeRun()?.abort()
    const children = await this.kit.store.listSessions({ parentSessionId: this.id, limit: 1000 })
    for (const c of children.sessions) await new Session(this.kit, c).delete()
    await this.kit.store.deleteSession(this.id)
  }

  /** Subagent sessions started from this one. */
  async children(): Promise<Session<Ctx>[]> {
    const page = await this.kit.store.listSessions({ parentSessionId: this.id, limit: 1000 })
    return page.sessions.map((s) => new Session(this.kit, s))
  }

  private async prepare(run: Run, options: SendOptions<Ctx>): Promise<SessionRecord> {
    await this.kit.ready()
    let rec = await this.kit.store.getSession(this.id)
    if (!rec) throw new Error(`Session ${this.id} not found`)
    const active = rec.activeRunId ? this.kit.getRun(rec.activeRunId) : undefined
    if (active && active !== run && !active.done) {
      if (!options.interrupt) throw new Error("This session already has a run in progress. Pass { interrupt: true } to stop it.")
      active.abort()
      await active.result
      rec = (await this.kit.store.getSession(this.id))!
    }
    this.rec = rec
    return rec
  }

  private failRun(run: Run, e: unknown) {
    run.fail(e)
    this.kit.unregisterRun(run)
  }
}
