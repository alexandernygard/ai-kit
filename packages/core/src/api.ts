import type { AgentInfo } from "./kit"
import type { Message, Part } from "./messages"
import type { ToolResponse } from "./run"
import type { SessionRecord } from "./store/types"

/*
 * The HTTP contract between @alexandernygard/ai-kit-server and -client. Run endpoints answer
 * with server-sent events of EventEnvelope; everything else is JSON.
 */

/** A session as the API returns it. Internal state is left out. */
export type SessionInfo = Omit<SessionRecord, "state"> & { state: Record<string, unknown> }

export interface SessionDetail {
  session: SessionInfo
  /** Every message, all branches. Use `pathTo(messages, session.headId)` for the active one. */
  messages: Message[]
}

export interface ListSessionsResponse {
  sessions: SessionInfo[]
  nextCursor?: string
}

export interface AgentsResponse {
  agents: AgentInfo[]
}

export interface CreateSessionBody {
  agent?: string
  title?: string
  metadata?: Record<string, unknown>
}

/** What the browser knows and the agent should too: the page, a selection. Untrusted on the server. */
export type ClientContext = Record<string, unknown>

export interface SendBody {
  content: string | Part[]
  clientContext?: ClientContext
  parentId?: string | null
  editOf?: string
  agent?: string
  metadata?: Record<string, unknown>
  /** Stop a run in progress first. */
  interrupt?: boolean
}

export interface ResumeBody {
  responses: Record<string, ToolResponse>
  clientContext?: ClientContext
}

export interface RespondBody {
  toolCallId: string
  response: ToolResponse
  clientContext?: ClientContext
}

/** `respond` either reached a live run (JSON) or started a new one (event stream). */
export interface RespondLiveResponse {
  live: true
  runId: string
}

export interface RegenerateBody {
  messageId?: string
  clientContext?: ClientContext
}

export interface ForkBody {
  messageId?: string | null
  title?: string
}

export interface BranchBody {
  messageId: string
}

export interface ApiError {
  error: string
  code?: string
}

// Left by harness drivers in sessions created before they were removed.
const HIDDEN_STATE = ["ai-kit.harnessSessions", "ai-kit.harnessFork"]

export function toSessionInfo(rec: SessionRecord): SessionInfo {
  const state = { ...rec.state }
  for (const k of HIDDEN_STATE) delete state[k]
  return { ...rec, state }
}
