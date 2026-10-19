import { createId, now } from "./id"
import type { Usage } from "./usage"

export type Role = "user" | "assistant" | "system"

export type MessageStatus = "streaming" | "complete" | "awaiting-input" | "aborted" | "error"

/**
 * A message in a session. Messages form a tree through `parentId`, so a session can hold
 * several branches (edits, regenerations) and the session's `headId` picks the active one.
 *
 * An assistant message holds every step of one run: reasoning, text and tool calls with
 * their results, separated by `step` parts.
 */
export interface Message<Meta = Record<string, unknown>> {
  id: string
  role: Role
  parts: Part[]
  parentId: string | null
  createdAt: number
  /** The agent that wrote an assistant message. */
  agent?: string
  /** The model that wrote it, as `provider:model`. */
  model?: string
  status?: MessageStatus
  usage?: Usage
  metadata?: Meta
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | SourcePart
  | DataPart
  | StepPart

export interface TextPart {
  type: "text"
  id: string
  text: string
  state?: "streaming" | "done"
}

export interface ReasoningPart {
  type: "reasoning"
  id: string
  text: string
  state?: "streaming" | "done"
  /** Provider data needed to send the reasoning back (Anthropic signatures, OpenAI encrypted content). */
  providerMetadata?: Record<string, unknown>
}

/**
 * Where a tool runs.
 * - `server`: executed by ai-kit wherever the runner runs.
 * - `client`: executed by the browser; the run pauses until the client sends the output.
 * - `provider`: executed by the model provider (web search, code execution).
 * - `harness`: executed by an agent harness (Claude Code's Bash, Codex's shell).
 */
export type ToolRuntime = "server" | "client" | "provider" | "harness"

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "awaiting-approval"
  | "awaiting-output"
  | "running"
  | "output-available"
  | "output-error"
  | "denied"

export interface ToolPart {
  type: "tool"
  toolCallId: string
  toolName: string
  state: ToolState
  runtime: ToolRuntime
  input?: unknown
  /** Raw input JSON while it streams. */
  inputText?: string
  output?: unknown
  error?: string
  /** Short label for UIs, from the tool's `title`. */
  title?: string
  approval?: {
    reason?: string
    /** `wait`: the run is paused in memory. `suspend`: the run ended and must be resumed. */
    mode: "wait" | "suspend"
    approved?: boolean
    message?: string
  }
  /** Progress values the tool reported while running. Only the latest few are kept. */
  progress?: unknown[]
  /** Set for calls made from inside code mode or by a subagent's parent call. */
  parentToolCallId?: string
  /** Child session for subagent calls. */
  childSessionId?: string
  /** Live subagent message. Only set by clients that reduce with `nestSubagents`; never stored. */
  child?: Message
  startedAt?: number
  endedAt?: number
  providerMetadata?: Record<string, unknown>
}

export interface FilePart {
  type: "file"
  id: string
  mediaType: string
  filename?: string
  /** A URL (https or data:) or base64 data. */
  url?: string
  data?: string
}

export interface SourcePart {
  type: "source"
  id: string
  url: string
  title?: string
}

/** App data in a message, for custom UI. `name` lets UIs pick a renderer. */
export interface DataPart<T = unknown> {
  type: "data"
  id: string
  name: string
  data: T
}

export interface StepPart {
  type: "step"
  index: number
}

export type UserContent = string | Part[] | { parts: Part[]; metadata?: Record<string, unknown> }

export function userMessage(content: UserContent, parentId: string | null = null): Message {
  const parts =
    typeof content === "string"
      ? [textPart(content)]
      : Array.isArray(content)
        ? content
        : content.parts
  return {
    id: createId("msg"),
    role: "user",
    parts,
    parentId,
    createdAt: now(),
    status: "complete",
    metadata: typeof content === "object" && !Array.isArray(content) ? content.metadata : undefined,
  }
}

export function textPart(text: string): TextPart {
  return { type: "text", id: createId("txt", 8), text, state: "done" }
}

export function filePart(file: Omit<FilePart, "type" | "id">): FilePart {
  return { type: "file", id: createId("file", 8), ...file }
}

/** All text in a message, or in a list of parts. */
export function textOf(message: Message | Part[] | undefined): string {
  if (!message) return ""
  const parts = Array.isArray(message) ? message : message.parts
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("")
}

/** Text after the last step boundary: the agent's final answer. */
export function finalTextOf(message: Message | undefined): string {
  if (!message) return ""
  let lastStep = -1
  message.parts.forEach((p, i) => {
    if (p.type === "step") lastStep = i
  })
  return textOf(message.parts.slice(lastStep + 1))
}

export function toolParts(message: Message | undefined): ToolPart[] {
  return (message?.parts ?? []).filter((p): p is ToolPart => p.type === "tool")
}

/** Tool calls that hold up the run: approvals and client tools. */
export function pendingToolParts(message: Message | undefined): ToolPart[] {
  return toolParts(message).filter((p) => p.state === "awaiting-approval" || p.state === "awaiting-output")
}

/**
 * The messages from the root to `headId`, following `parentId`.
 * This is the conversation the model sees.
 */
export function pathTo(messages: Message[], headId: string | null | undefined): Message[] {
  if (!headId) return []
  const byId = new Map(messages.map((m) => [m.id, m]))
  const path: Message[] = []
  let cur = byId.get(headId)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.push(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return path.reverse()
}

/** Messages that share a parent with `messageId`, in creation order, including itself. */
export function siblingsOf(messages: Message[], messageId: string): Message[] {
  const msg = messages.find((m) => m.id === messageId)
  if (!msg) return []
  return messages
    .filter((m) => m.parentId === msg.parentId && m.role === msg.role)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** The newest leaf under `messageId`, used to pick a branch's head when switching to it. */
export function leafOf(messages: Message[], messageId: string): string {
  let cur = messageId
  for (;;) {
    const children = messages.filter((m) => m.parentId === cur).sort((a, b) => b.createdAt - a.createdAt)
    const next = children[0]
    if (!next) return cur
    cur = next.id
  }
}
