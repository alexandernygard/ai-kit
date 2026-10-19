import {
  type AgentsResponse,
  type ApiError,
  type BranchBody,
  type CreateSessionBody,
  type EventEnvelope,
  type ForkBody,
  type Kit,
  type ListSessionsResponse,
  type RegenerateBody,
  type RespondBody,
  type ResumeBody,
  type Run,
  type RunOptions,
  type SendBody,
  type Session,
  type SessionDetail,
  sseResponse,
  toSessionInfo,
} from "@alexandernygard/ai-kit"

export interface AuthResult<Ctx = any> {
  /** Sessions are owned by and scoped to this user. Leave out for single-user apps. */
  userId?: string
  /** Passed to tools, hooks and instructions as `ctx.context`. */
  context?: Ctx
}

export interface HandlerOptions<Ctx = any> {
  /** Where the routes live. Default `/api/ai`. */
  basePath?: string
  /**
   * Who is calling. Return null to answer 401. Without it every request is anonymous and
   * every session is shared, which is only right for local tools.
   */
  auth?: (req: Request) => AuthResult<Ctx> | null | Promise<AuthResult<Ctx> | null>
  /** Agents clients may use. Default: all top-level agents (not subagents-only). */
  agents?: string[]
  /** Server-side run settings: permission mode, limits, approval handling. */
  runOptions?: (ctx: { req: Request; session: Session<Ctx>; auth: AuthResult<Ctx> }) => Partial<RunOptions<Ctx>> | Promise<Partial<RunOptions<Ctx>>>
  /** Allow cross-origin requests from these origins (`*` for any). */
  cors?: string | string[]
}

export interface HandlerExtras {
  /**
   * Keep a run alive after the response ends, on platforms that stop work when the response
   * closes: Cloudflare's `ctx.waitUntil`, Vercel's `waitUntil`.
   */
  waitUntil?: (promise: Promise<unknown>) => void
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * The ai-kit HTTP API as one fetch handler.
 *
 * ```ts
 * // Hono
 * app.all("/api/ai/*", (c) => handler(c.req.raw, { waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) }))
 * // Next.js app/api/ai/[...path]/route.ts
 * export const { GET, POST, PATCH, DELETE } = nextHandlers(handler)
 * // SvelteKit src/routes/api/ai/[...path]/+server.ts
 * export const fallback = ({ request }) => handler(request)
 * ```
 */
export function createHandler<Ctx = any>(kit: Kit<Ctx>, options: HandlerOptions<Ctx> = {}) {
  const base = (options.basePath ?? "/api/ai").replace(/\/$/, "")
  const routes = buildRoutes(kit, options)

  return async function handler(req: Request, extras: HandlerExtras = {}): Promise<Response> {
    const cors = corsHeaders(req, options.cors)
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    try {
      const url = new URL(req.url)
      if (!url.pathname.startsWith(base)) throw new HttpError(404, "Not found")
      const path = url.pathname.slice(base.length) || "/"
      const auth = options.auth ? await options.auth(req) : {}
      if (!auth) throw new HttpError(401, "Unauthorized")
      for (const r of routes) {
        if (r.method !== req.method) continue
        const m = r.pattern.exec(path)
        if (!m) continue
        const res = await r.handle({ req, url, params: m.groups ?? {}, auth, extras })
        cors.forEach((v, k) => res.headers.set(k, v))
        return res
      }
      throw new HttpError(404, "Not found")
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      const body: ApiError = { error: e instanceof Error ? e.message : String(e) }
      if (status === 500) console.error("[ai-kit]", e)
      return json(body, status, cors)
    }
  }
}

interface RouteCtx<Ctx> {
  req: Request
  url: URL
  params: Record<string, string>
  auth: AuthResult<Ctx>
  extras: HandlerExtras
}

function buildRoutes<Ctx>(kit: Kit<Ctx>, options: HandlerOptions<Ctx>) {
  const allowed = async (name: string) => {
    if (options.agents) return options.agents.includes(name)
    return (await kit.agents()).some((a) => a.name === name)
  }

  const load = async (id: string, auth: AuthResult<Ctx>) => {
    const s = await kit.getSession(id)
    // Same answer for missing and not-yours, so ids can't be probed.
    if (!s || (auth.userId !== undefined && s.record.ownerId !== auth.userId)) throw new HttpError(404, "Session not found")
    return s
  }

  const runOpts = async (ctx: RouteCtx<Ctx>, session: Session<Ctx>): Promise<RunOptions<Ctx>> => ({
    ...(await options.runOptions?.({ req: ctx.req, session, auth: ctx.auth })),
    context: ctx.auth.context as Ctx,
  })

  const stream = (run: Run, ctx: RouteCtx<Ctx>) => {
    ctx.extras.waitUntil?.(run.result)
    const res = sseResponse(run.events(-1, ctx.req.signal))
    res.headers.set("x-run-id", run.id)
    res.headers.set("x-session-id", run.sessionId)
    return res
  }

  const route = (method: string, path: string, handle: (ctx: RouteCtx<Ctx>) => Promise<Response>) => ({
    method,
    pattern: new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>[^/]+)")}/?$`),
    handle,
  })

  return [
    route("GET", "/agents", async () => {
      const agents = (await kit.agents()).filter((a) => !options.agents || options.agents.includes(a.name))
      return json<AgentsResponse>({ agents })
    }),

    route("GET", "/sessions", async ({ url, auth }) => {
      const q = url.searchParams
      const page = await kit.store.listSessions({
        ownerId: auth.userId,
        agent: q.get("agent") ?? undefined,
        parentSessionId: q.get("parent") ?? null,
        limit: Math.min(Number(q.get("limit") ?? 50), 200),
        cursor: q.get("cursor") ?? undefined,
      })
      return json<ListSessionsResponse>({ sessions: page.sessions.map(toSessionInfo), nextCursor: page.nextCursor })
    }),

    route("POST", "/sessions", async ({ req, auth }) => {
      const body = await read<CreateSessionBody>(req)
      if (body.agent && !(await allowed(body.agent))) throw new HttpError(400, `Unknown agent ${body.agent}`)
      const s = await kit.createSession({ agent: body.agent, title: body.title, metadata: body.metadata, ownerId: auth.userId })
      return json(toSessionInfo(s.record), 201)
    }),

    route("GET", "/sessions/:id", async ({ params, auth }) => {
      const s = await load(params.id!, auth)
      return json<SessionDetail>({ session: toSessionInfo(s.record), messages: await s.messages() })
    }),

    route("PATCH", "/sessions/:id", async ({ req, params, auth }) => {
      const s = await load(params.id!, auth)
      const body = await read<{ title?: string; metadata?: Record<string, unknown> }>(req)
      await s.update({ title: body.title, metadata: body.metadata })
      return json(toSessionInfo(s.record))
    }),

    route("DELETE", "/sessions/:id", async ({ params, auth }) => {
      await (await load(params.id!, auth)).delete()
      return new Response(null, { status: 204 })
    }),

    route("GET", "/sessions/:id/children", async ({ params, auth }) => {
      const s = await load(params.id!, auth)
      return json<ListSessionsResponse>({ sessions: (await s.children()).map((c) => toSessionInfo(c.record)) })
    }),

    route("POST", "/sessions/:id/messages", async (ctx) => {
      const s = await load(ctx.params.id!, ctx.auth)
      const body = await read<SendBody>(ctx.req)
      if (body.content === undefined) throw new HttpError(400, "content is required")
      if (body.agent && !(await allowed(body.agent))) throw new HttpError(400, `Unknown agent ${body.agent}`)
      const run = s.send(body.content, {
        ...(await runOpts(ctx, s)),
        parentId: body.parentId,
        editOf: body.editOf,
        agent: body.agent,
        metadata: body.metadata,
        interrupt: body.interrupt,
      })
      return stream(run, ctx)
    }),

    route("POST", "/sessions/:id/resume", async (ctx) => {
      const s = await load(ctx.params.id!, ctx.auth)
      const body = await read<ResumeBody>(ctx.req)
      return stream(s.resume(body.responses ?? {}, await runOpts(ctx, s)), ctx)
    }),

    route("POST", "/sessions/:id/respond", async (ctx) => {
      const s = await load(ctx.params.id!, ctx.auth)
      const body = await read<RespondBody>(ctx.req)
      const live = s.activeRun()
      if (live && live.respond(body.toolCallId, body.response)) return json({ live: true, runId: live.id })
      return stream(s.resume({ [body.toolCallId]: body.response }, await runOpts(ctx, s)), ctx)
    }),

    route("POST", "/sessions/:id/regenerate", async (ctx) => {
      const s = await load(ctx.params.id!, ctx.auth)
      const body = await read<RegenerateBody>(ctx.req)
      return stream(s.regenerate(body.messageId, await runOpts(ctx, s)), ctx)
    }),

    route("POST", "/sessions/:id/fork", async ({ req, params, auth }) => {
      const s = await load(params.id!, auth)
      const body = await read<ForkBody>(req)
      const fork = await s.fork({ messageId: body.messageId, title: body.title })
      return json<SessionDetail>({ session: toSessionInfo(fork.record), messages: await fork.messages() }, 201)
    }),

    route("POST", "/sessions/:id/branch", async ({ req, params, auth }) => {
      const s = await load(params.id!, auth)
      const body = await read<BranchBody>(req)
      await s.switchBranch(body.messageId)
      return json<SessionDetail>({ session: toSessionInfo(s.record), messages: await s.messages() })
    }),

    route("POST", "/sessions/:id/compact", async ({ params, auth }) => {
      const s = await load(params.id!, auth)
      return json({ summary: await s.compact() })
    }),

    route("POST", "/sessions/:id/abort", async ({ params, auth }) => {
      const s = await load(params.id!, auth)
      s.activeRun()?.abort()
      return json({ ok: true })
    }),

    route("GET", "/runs/:runId/events", async ({ req, url, params, auth }) => {
      const runId = params.runId!
      const live = kit.getRun(runId)
      const sessionId = live?.sessionId ?? url.searchParams.get("session")
      if (!sessionId) throw new HttpError(400, "Pass ?session=<id> to replay a finished run")
      await load(sessionId, auth)
      const after = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? -1)
      const res = sseResponse(kit.runEvents(runId, after, req.signal) as AsyncIterable<EventEnvelope>)
      res.headers.set("x-run-id", runId)
      return res
    }),

    route("POST", "/runs/:runId/abort", async ({ params, auth }) => {
      const run = kit.getRun(params.runId!)
      if (!run) throw new HttpError(404, "Run not found or already finished")
      await load(run.sessionId, auth)
      run.abort()
      return json({ ok: true })
    }),
  ]
}

async function read<T>(req: Request): Promise<T> {
  const text = await req.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, "Body must be JSON")
  }
}

function json<T>(body: T, status = 200, headers?: Headers): Response {
  const h = new Headers(headers)
  h.set("content-type", "application/json")
  return new Response(JSON.stringify(body), { status, headers: h })
}

function corsHeaders(req: Request, cors: HandlerOptions["cors"]): Headers {
  const h = new Headers()
  if (!cors) return h
  const origin = req.headers.get("origin")
  const list = Array.isArray(cors) ? cors : [cors]
  if (origin && (list.includes("*") || list.includes(origin))) {
    h.set("access-control-allow-origin", list.includes("*") ? "*" : origin)
    h.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS")
    h.set("access-control-allow-headers", req.headers.get("access-control-request-headers") ?? "content-type, authorization")
    h.set("access-control-expose-headers", "x-run-id, x-session-id")
    h.set("vary", "origin")
  }
  return h
}

/** Route handlers for a Next.js catch-all route. */
export function nextHandlers(handler: (req: Request) => Promise<Response>) {
  const h = (req: Request) => handler(req)
  return { GET: h, POST: h, PATCH: h, DELETE: h, OPTIONS: h }
}
