import type { EventEnvelope } from "../events"
import type { Message } from "../messages"
import type { ListSessionsQuery, SessionRecord, Store } from "./types"

/**
 * Run one SQL statement. Wrap your driver: better-sqlite3, node:sqlite, Cloudflare D1,
 * Turso/libsql, postgres.js, pg. Use `?` placeholders; set `dialect: "postgres"` to get `$1`.
 */
export type SqlExecutor = (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>

export interface SqlStoreOptions {
  exec: SqlExecutor
  dialect?: "sqlite" | "postgres"
  /** Table name prefix. Default `ai_kit_`. */
  prefix?: string
}

/** The tables `sqlStore` uses. Run once, or call `store.migrate()`. */
export function sqlSchema(options: { prefix?: string; dialect?: "sqlite" | "postgres" } = {}): string[] {
  const p = options.prefix ?? "ai_kit_"
  const big = options.dialect === "postgres" ? "BIGINT" : "INTEGER"
  return [
    `CREATE TABLE IF NOT EXISTS ${p}sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      owner_id TEXT,
      parent_session_id TEXT,
      updated_at ${big} NOT NULL,
      data TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${p}sessions_owner ON ${p}sessions (owner_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS ${p}sessions_parent ON ${p}sessions (parent_session_id)`,
    `CREATE TABLE IF NOT EXISTS ${p}messages (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      created_at ${big} NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )`,
  ]
}

export function sqlStore(options: SqlStoreOptions): Store & { migrate(): Promise<void> } {
  const p = options.prefix ?? "ai_kit_"
  const pg = options.dialect === "postgres"
  const q = (sql: string, params: unknown[] = []) => {
    let n = 0
    return options.exec(pg ? sql.replace(/\?/g, () => `$${++n}`) : sql, params)
  }
  const upsert = pg ? "ON CONFLICT (session_id, id) DO UPDATE SET data = EXCLUDED.data, created_at = EXCLUDED.created_at" : ""
  const parse = <T>(row: Record<string, unknown> | undefined): T | null => (row ? (JSON.parse(String(row.data)) as T) : null)

  const putSession = async (s: SessionRecord, insert: boolean) => {
    const params = [s.id, s.agent, s.ownerId ?? null, s.parentSessionId ?? null, s.updatedAt, JSON.stringify(s)]
    if (insert) {
      await q(`INSERT INTO ${p}sessions (id, agent, owner_id, parent_session_id, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)`, params)
    } else {
      await q(`UPDATE ${p}sessions SET agent = ?, owner_id = ?, parent_session_id = ?, updated_at = ?, data = ? WHERE id = ?`, [...params.slice(1), s.id])
    }
  }

  return {
    async migrate() {
      for (const stmt of sqlSchema({ prefix: p, dialect: options.dialect })) await q(stmt)
    },
    async createSession(s) {
      await putSession(s, true)
    },
    async getSession(id) {
      return parse<SessionRecord>((await q(`SELECT data FROM ${p}sessions WHERE id = ?`, [id]))[0])
    },
    async updateSession(id, patch) {
      const cur = parse<SessionRecord>((await q(`SELECT data FROM ${p}sessions WHERE id = ?`, [id]))[0])
      if (!cur) throw new Error(`Session ${id} not found`)
      const next = { ...cur, ...patch, id, updatedAt: patch.updatedAt ?? Date.now() }
      await putSession(next, false)
      return next
    },
    async deleteSession(id) {
      await q(`DELETE FROM ${p}messages WHERE session_id = ?`, [id])
      await q(`DELETE FROM ${p}sessions WHERE id = ?`, [id])
    },
    async listSessions(query: ListSessionsQuery) {
      const where: string[] = []
      const params: unknown[] = []
      if (query.ownerId !== undefined) (where.push("owner_id = ?"), params.push(query.ownerId))
      if (query.agent !== undefined) (where.push("agent = ?"), params.push(query.agent))
      if (query.parentSessionId === undefined || query.parentSessionId === null) where.push("parent_session_id IS NULL")
      else (where.push("parent_session_id = ?"), params.push(query.parentSessionId))
      const limit = query.limit ?? 50
      const offset = query.cursor ? Number(query.cursor) : 0
      const rows = await q(
        `SELECT data FROM ${p}sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
        [...params, limit + 1, offset],
      )
      const sessions = rows.slice(0, limit).map((r) => parse<SessionRecord>(r)!)
      return { sessions, nextCursor: rows.length > limit ? String(offset + limit) : undefined }
    },
    async getMessages(sid) {
      const rows = await q(`SELECT data FROM ${p}messages WHERE session_id = ? ORDER BY created_at ASC`, [sid])
      return rows.map((r) => parse<Message>(r)!)
    },
    async putMessage(sid, m) {
      const sql = pg
        ? `INSERT INTO ${p}messages (session_id, id, created_at, data) VALUES (?, ?, ?, ?) ${upsert}`
        : `INSERT OR REPLACE INTO ${p}messages (session_id, id, created_at, data) VALUES (?, ?, ?, ?)`
      await q(sql, [sid, m.id, m.createdAt, JSON.stringify(m)])
    },
    async deleteMessage(sid, mid) {
      await q(`DELETE FROM ${p}messages WHERE session_id = ? AND id = ?`, [sid, mid])
    },
    async appendEvents(runId, events) {
      for (const e of events) {
        await q(`INSERT INTO ${p}events (run_id, seq, data) VALUES (?, ?, ?)`, [runId, e.seq, JSON.stringify(e)])
      }
    },
    async readEvents(runId, after = -1) {
      const rows = await q(`SELECT data FROM ${p}events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`, [runId, after])
      return rows.map((r) => parse<EventEnvelope>(r)!)
    },
  }
}
