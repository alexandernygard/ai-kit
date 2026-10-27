import type { EventEnvelope } from "../events"
import type { Message } from "../messages"

export interface SessionRecord {
  id: string
  /** Agent name. */
  agent: string
  title?: string
  /** Who owns it, for multi-user apps. The server scopes queries by it. */
  ownerId?: string
  /** The message at the tip of the active branch. */
  headId: string | null
  /** Set for subagent sessions. */
  parentSessionId?: string
  parentToolCallId?: string
  /** Set for forks. */
  forkedFrom?: { sessionId: string; messageId: string | null }
  /** Runtime state: loaded tools and skills, todos, remembered approvals. */
  state: Record<string, unknown>
  metadata?: Record<string, unknown>
  /** Set while a run is active. */
  activeRunId?: string | null
  /**
   * The active run renews this while it's alive. Once it has passed, the run is treated as
   * dead (its process crashed or was reloaded) and the session is recovered on next load.
   */
  activeRunLeaseUntil?: number | null
  createdAt: number
  updatedAt: number
}

export interface ListSessionsQuery {
  ownerId?: string
  agent?: string
  /** `null` lists only top-level sessions (the default); a string lists that session's children. */
  parentSessionId?: string | null
  limit?: number
  /** Opaque cursor from the previous page. */
  cursor?: string
}

export interface SessionPage {
  sessions: SessionRecord[]
  nextCursor?: string
}

/**
 * Where sessions, messages and run events live. Implement it for your database, or use
 * `memoryStore()`, `kvStore()` (any key-value store) or the file and SQL stores.
 */
export interface Store {
  createSession(session: SessionRecord): Promise<void>
  getSession(id: string): Promise<SessionRecord | null>
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord>
  deleteSession(id: string): Promise<void>
  listSessions(query: ListSessionsQuery): Promise<SessionPage>

  /** Every message in the session, all branches. */
  getMessages(sessionId: string): Promise<Message[]>
  /** Insert or replace by id. */
  putMessage(sessionId: string, message: Message): Promise<void>
  deleteMessage(sessionId: string, messageId: string): Promise<void>

  /** Optional event log so clients can reconnect to a run. */
  appendEvents?(runId: string, events: EventEnvelope[]): Promise<void>
  readEvents?(runId: string, after?: number): Promise<EventEnvelope[]>
}
