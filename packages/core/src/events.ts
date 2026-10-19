import type { DataPart, FilePart, Message, SourcePart, ToolRuntime } from "./messages"
import type { Usage } from "./usage"

export type FinishReason =
  /** The agent finished. */
  | "stop"
  /** Waiting on approvals or client tool outputs. Resume the session to continue. */
  | "awaiting-input"
  | "max-steps"
  | "length"
  | "budget"
  | "aborted"
  | "error"
  | "content-filter"

/**
 * Everything a run reports, in order. The same events flow from runner to server to client,
 * and `applyEvent` turns them into messages on both ends.
 */
export type AgentEvent =
  | { type: "run-start"; runId: string; sessionId: string; agent: string; userMessage?: Message; message: Message }
  | { type: "step-start"; step: number }
  | { type: "text-delta"; partId: string; delta: string }
  | { type: "text-end"; partId: string }
  | { type: "reasoning-delta"; partId: string; delta: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning-end"; partId: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool-input-start"; toolCallId: string; toolName: string; runtime: ToolRuntime; parentToolCallId?: string }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      input: unknown
      runtime: ToolRuntime
      title?: string
      parentToolCallId?: string
      providerMetadata?: Record<string, unknown>
    }
  | { type: "tool-approval-request"; toolCallId: string; reason?: string; mode: "wait" | "suspend" }
  | { type: "tool-approval-response"; toolCallId: string; approved: boolean; message?: string }
  | { type: "tool-awaiting-output"; toolCallId: string; mode: "wait" | "suspend" }
  | { type: "tool-start"; toolCallId: string }
  | { type: "tool-progress"; toolCallId: string; data: unknown }
  | { type: "tool-result"; toolCallId: string; output: unknown; isError?: boolean; providerMetadata?: Record<string, unknown> }
  | { type: "tool-child-session"; toolCallId: string; sessionId: string }
  /** An event from a subagent, wrapped with the tool call that started it. */
  | { type: "subagent"; toolCallId: string; sessionId: string; event: AgentEvent }
  | { type: "data"; part: DataPart; transient?: boolean }
  | { type: "file"; part: FilePart }
  | { type: "source"; part: SourcePart }
  | { type: "step-finish"; step: number; usage: Usage; finishReason: string }
  | { type: "status"; status: string; detail?: string }
  | { type: "compaction"; summary: string; uptoMessageId: string }
  | { type: "session-update"; patch: { title?: string; state?: Record<string, unknown>; metadata?: Record<string, unknown> } }
  | { type: "run-finish"; finishReason: FinishReason; usage: Usage; output?: unknown; message: Message }
  | { type: "error"; error: { message: string; code?: string } }

export type AgentEventType = AgentEvent["type"]

export type EventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>

/** An event with its position in the run's stream, for reconnecting with `after`. */
export interface EventEnvelope {
  seq: number
  runId: string
  event: AgentEvent
}
