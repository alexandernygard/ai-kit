import {
  type AgentInfo,
  type BranchBody,
  type CreateSessionBody,
  decodeSSE,
  type EventEnvelope,
  type ForkBody,
  type Kit,
  type ListSessionsResponse,
  type RegenerateBody,
  type RespondBody,
  type RespondLiveResponse,
  type ResumeBody,
  type Run,
  type RunOptions,
  type SendBody,
  type SessionDetail,
  type SessionInfo,
  toSessionInfo,
} from "@alexandernygard/ai-kit"

export interface RunStream {
  /** Known up front over HTTP (from headers) and in-process. */
  runId: string | null
  events: AsyncIterable<EventEnvelope>
}

export interface ListQuery {
  agent?: string
  parent?: string
  limit?: number
  cursor?: string
}

/** How the client reaches a kit: over HTTP, or in the same process. */
export interface Transport {
  agents(): Promise<AgentInfo[]>
  listSessions(query?: ListQuery): Promise<ListSessionsResponse>
  createSession(body?: CreateSessionBody): Promise<SessionInfo>
  getSession(id: string): Promise<SessionDetail>
  updateSession(id: string, patch: { title?: string; metadata?: Record<string, unknown> }): Promise<SessionInfo>
  deleteSession(id: string): Promise<void>
  children(id: string): Promise<ListSessionsResponse>
  fork(id: string, body?: ForkBody): Promise<SessionDetail>
  branch(id: string, body: BranchBody): Promise<SessionDetail>
  send(id: string, body: SendBody, signal?: AbortSignal): Promise<RunStream>
  resume(id: string, body: ResumeBody, signal?: AbortSignal): Promise<RunStream>
  respond(id: string, body: RespondBody, signal?: AbortSignal): Promise<RunStream | RespondLiveResponse>
  regenerate(id: string, body: RegenerateBody, signal?: AbortSignal): Promise<RunStream>
  /** Join a run's events after `after` (reconnecting, or opening a session mid-run). */
  events(runId: string, options: { sessionId: string; after?: number }, signal?: AbortSignal): Promise<RunStream>
  abort(sessionId: string): Promise<void>
  compact(id: string): Promise<{ summary: string | null }>
}

export class AiKitHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "AiKitHttpError"
  }
}

export interface HttpTransportOptions {
  /** Where the server handler is mounted. Default `/api/ai`. */
  baseUrl?: string
  fetch?: typeof fetch
  /** Sent with every request, e.g. an Authorization header. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  credentials?: RequestCredentials
}

/** Talk to `@alexandernygard/ai-kit-server`. */
export function httpTransport(options: HttpTransportOptions = {}): Transport {
  const base = (options.baseUrl ?? "/api/ai").replace(/\/$/, "")
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))

  const request = async (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
    const headers = new Headers(typeof options.headers === "function" ? await options.headers() : options.headers)
    if (body !== undefined) headers.set("content-type", "application/json")
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: options.credentials,
    })
    if (!res.ok) {
      let message = res.statusText
      try {
        message = ((await res.json()) as { error?: string }).error ?? message
      } catch {}
      throw new AiKitHttpError(res.status, message)
    }
    return res
  }
  const json = async <T>(method: string, path: string, body?: unknown) => {
    const res = await request(method, path, body)
    return (res.status === 204 ? undefined : await res.json()) as T
  }
  const stream = async (method: string, path: string, body: unknown, signal?: AbortSignal): Promise<RunStream> => {
    const res = await request(method, path, body, signal)
    if (!res.body) throw new AiKitHttpError(500, "No response body")
    return { runId: res.headers.get("x-run-id"), events: decodeSSE(res.body, signal) }
  }
  const e = encodeURIComponent

  return {
    agents: async () => (await json<{ agents: AgentInfo[] }>("GET", "/agents")).agents,
    listSessions: (q = {}) => {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v))
      const qs = params.toString()
      return json("GET", `/sessions${qs ? `?${qs}` : ""}`)
    },
    createSession: (body = {}) => json("POST", "/sessions", body),
    getSession: (id) => json("GET", `/sessions/${e(id)}`),
    updateSession: (id, patch) => json("PATCH", `/sessions/${e(id)}`, patch),
    deleteSession: async (id) => void (await request("DELETE", `/sessions/${e(id)}`)),
    children: (id) => json("GET", `/sessions/${e(id)}/children`),
    fork: (id, body = {}) => json("POST", `/sessions/${e(id)}/fork`, body),
    branch: (id, body) => json("POST", `/sessions/${e(id)}/branch`, body),
    send: (id, body, signal) => stream("POST", `/sessions/${e(id)}/messages`, body, signal),
    resume: (id, body, signal) => stream("POST", `/sessions/${e(id)}/resume`, body, signal),
    regenerate: (id, body, signal) => stream("POST", `/sessions/${e(id)}/regenerate`, body, signal),
    async respond(id, body, signal) {
      const res = await request("POST", `/sessions/${e(id)}/respond`, body, signal)
      if (res.headers.get("content-type")?.includes("application/json")) return (await res.json()) as RespondLiveResponse
      return { runId: res.headers.get("x-run-id"), events: decodeSSE(res.body!, signal) }
    },
    events: (runId, o, signal) => stream("GET", `/runs/${e(runId)}/events?session=${e(o.sessionId)}&after=${o.after ?? -1}`, undefined, signal),
    abort: async (id) => void (await request("POST", `/sessions/${e(id)}/abort`, {})),
    compact: (id) => json("POST", `/sessions/${e(id)}/compact`, {}),
  }
}

export interface DirectTransportOptions<Ctx> {
  /** Owner for new sessions and the scope for listing. */
  ownerId?: string
  context?: Ctx
  runOptions?: Partial<RunOptions<Ctx>>
}

/**
 * Use a kit in the same process: a browser-only app, Electron, a CLI, or tests. Same API as
 * the HTTP transport, so UI code doesn't change.
 */
export function directTransport<Ctx>(kit: Kit<Ctx>, options: DirectTransportOptions<Ctx> = {}): Transport {
  const opts = (body?: { clientContext?: Record<string, unknown> }) => ({ ...options.runOptions, context: options.context as Ctx, clientContext: body?.clientContext })
  const load = async (id: string) => {
    const s = await kit.getSession(id)
    if (!s || (options.ownerId !== undefined && s.record.ownerId !== options.ownerId)) throw new AiKitHttpError(404, "Session not found")
    return s
  }
  const detail = async (id: string): Promise<SessionDetail> => {
    const s = await load(id)
    return { session: toSessionInfo(s.record), messages: await s.messages() }
  }
  const fromRun = (run: Run, signal?: AbortSignal): RunStream => ({ runId: run.id, events: run.events(-1, signal) })

  return {
    agents: () => kit.agents(),
    async listSessions(q = {}) {
      const page = await kit.store.listSessions({ ownerId: options.ownerId, agent: q.agent, parentSessionId: q.parent ?? null, limit: q.limit, cursor: q.cursor })
      return { sessions: page.sessions.map(toSessionInfo), nextCursor: page.nextCursor }
    },
    async createSession(body = {}) {
      return toSessionInfo((await kit.createSession({ ...body, ownerId: options.ownerId })).record)
    },
    getSession: detail,
    async updateSession(id, patch) {
      return toSessionInfo((await (await load(id)).update(patch)).record)
    },
    async deleteSession(id) {
      await (await load(id)).delete()
    },
    async children(id) {
      return { sessions: (await (await load(id)).children()).map((c) => toSessionInfo(c.record)) }
    },
    async fork(id, body = {}) {
      const f = await (await load(id)).fork(body)
      return detail(f.id)
    },
    async branch(id, body) {
      await (await load(id)).switchBranch(body.messageId)
      return detail(id)
    },
    async send(id, body, signal) {
      return fromRun((await load(id)).send(body.content, { ...opts(body), parentId: body.parentId, editOf: body.editOf, agent: body.agent, metadata: body.metadata, interrupt: body.interrupt }), signal)
    },
    async resume(id, body, signal) {
      return fromRun((await load(id)).resume(body.responses, opts(body)), signal)
    },
    async respond(id, body, signal) {
      const s = await load(id)
      const live = s.activeRun()
      if (live && live.respond(body.toolCallId, body.response)) return { live: true, runId: live.id }
      return fromRun(s.resume({ [body.toolCallId]: body.response }, opts(body)), signal)
    },
    async regenerate(id, body, signal) {
      return fromRun((await load(id)).regenerate(body.messageId, opts(body)), signal)
    },
    async events(runId, o, signal) {
      await load(o.sessionId)
      return { runId, events: kit.runEvents(runId, o.after ?? -1, signal) }
    },
    async abort(id) {
      ;(await load(id)).activeRun()?.abort()
    },
    async compact(id) {
      return { summary: await (await load(id)).compact() }
    },
  }
}
