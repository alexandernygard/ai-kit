import type { EventEnvelope } from "../events"
import type { Message } from "../messages"
import type { ListSessionsQuery, SessionPage, SessionRecord, Store } from "./types"

/**
 * The key-value operations `kvStore` needs. Cloudflare KV, Durable Object storage, Redis,
 * Deno KV, localStorage and IndexedDB all fit with a few lines of glue.
 */
export interface KV {
  get(key: string): Promise<string | null | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  /** Keys starting with `prefix`. */
  list(prefix: string): Promise<string[]>
}

export function memoryKV(map: Map<string, string> = new Map()): KV {
  return {
    async get(k) {
      return map.get(k)
    },
    async set(k, v) {
      map.set(k, v)
    },
    async delete(k) {
      map.delete(k)
    },
    async list(prefix) {
      return [...map.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

/**
 * A Store on any key-value store. Session listing reads every session record, so it suits
 * apps with up to a few thousand sessions per owner; use a SQL store beyond that.
 */
export function kvStore(kv: KV, options: { prefix?: string } = {}): Store {
  const p = options.prefix ?? "ai-kit:"
  const sessionKey = (id: string) => `${p}session:${id}`
  const msgPrefix = (sid: string) => `${p}msg:${sid}:`
  const msgKey = (sid: string, mid: string) => `${msgPrefix(sid)}${mid}`
  const eventKey = (runId: string) => `${p}events:${runId}`

  const read = async <T>(key: string): Promise<T | null> => {
    const raw = await kv.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  }

  return {
    async createSession(s) {
      await kv.set(sessionKey(s.id), JSON.stringify(s))
    },
    async getSession(id) {
      return read<SessionRecord>(sessionKey(id))
    },
    async updateSession(id, patch) {
      const cur = await read<SessionRecord>(sessionKey(id))
      if (!cur) throw new Error(`Session ${id} not found`)
      const next = { ...cur, ...patch, id, updatedAt: patch.updatedAt ?? Date.now() }
      await kv.set(sessionKey(id), JSON.stringify(next))
      return next
    },
    async deleteSession(id) {
      for (const k of await kv.list(msgPrefix(id))) await kv.delete(k)
      await kv.delete(sessionKey(id))
    },
    async listSessions(q: ListSessionsQuery): Promise<SessionPage> {
      const keys = await kv.list(`${p}session:`)
      const all = (await Promise.all(keys.map((k) => read<SessionRecord>(k)))).filter((s): s is SessionRecord => !!s)
      return pageSessions(all, q)
    },
    async getMessages(sid) {
      const keys = await kv.list(msgPrefix(sid))
      const msgs = (await Promise.all(keys.map((k) => read<Message>(k)))).filter((m): m is Message => !!m)
      return msgs.sort((a, b) => a.createdAt - b.createdAt)
    },
    async putMessage(sid, m) {
      await kv.set(msgKey(sid, m.id), JSON.stringify(m))
    },
    async deleteMessage(sid, mid) {
      await kv.delete(msgKey(sid, mid))
    },
    async appendEvents(runId, events) {
      const cur = (await read<EventEnvelope[]>(eventKey(runId))) ?? []
      await kv.set(eventKey(runId), JSON.stringify([...cur, ...events]))
    },
    async readEvents(runId, after = -1) {
      const cur = (await read<EventEnvelope[]>(eventKey(runId))) ?? []
      return cur.filter((e) => e.seq > after)
    },
  }
}

/** Filter, sort (newest first) and page sessions in memory. Shared by simple stores. */
export function pageSessions(all: SessionRecord[], q: ListSessionsQuery): SessionPage {
  const parent = q.parentSessionId === undefined ? null : q.parentSessionId
  const filtered = all
    .filter((s) => (q.ownerId === undefined || s.ownerId === q.ownerId))
    .filter((s) => (q.agent === undefined || s.agent === q.agent))
    .filter((s) => (parent === null ? !s.parentSessionId : s.parentSessionId === parent))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
  const start = q.cursor ? Number(q.cursor) : 0
  const limit = q.limit ?? 50
  const sessions = filtered.slice(start, start + limit)
  const next = start + limit < filtered.length ? String(start + limit) : undefined
  return { sessions, nextCursor: next }
}

/** An in-memory Store. Good for tests, scripts and the browser. Lost on restart. */
export function memoryStore(): Store {
  return kvStore(memoryKV())
}
