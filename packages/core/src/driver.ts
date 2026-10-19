import type { AgentEvent } from "./events"
import type { Message } from "./messages"
import type { JSONSchema } from "./schema"
import type { Usage } from "./usage"

/*
 * Drivers connect ai-kit to models. There are two kinds:
 *
 * - A ModelDriver makes one model call. ai-kit runs the agent loop around it, so every feature
 *   (approvals, client tools, code mode, tool search, compaction, hooks) works. Use it for API
 *   keys through the AI SDK.
 *
 * - A HarnessDriver hands a whole turn to an agent runtime that has its own loop, such as the
 *   Claude Agent SDK (your Claude subscription) or the Codex SDK (your ChatGPT subscription).
 *   ai-kit bridges its tools in over MCP, routes them through the same permission pipeline and
 *   maps the runtime's events onto AgentEvents.
 */

export type Driver = ModelDriver | HarnessDriver

// ---------------------------------------------------------------------------------------------
// Model drivers

export interface ModelDriver {
  readonly kind: "model"
  /** e.g. `anthropic`, `openai`. */
  readonly provider: string
  readonly modelId: string
  readonly capabilities?: ModelCapabilities
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}

export interface ModelCapabilities {
  /** Input tokens the model accepts. Compaction uses this when no limit is configured. */
  contextWindow?: number
  images?: boolean
  pdf?: boolean
  reasoning?: boolean
  /** Native JSON-schema output. Without it ai-kit uses a structured-output tool. */
  structuredOutput?: boolean
  promptCaching?: boolean
}

export interface SystemBlock {
  text: string
  /** Put a prompt-cache breakpoint after this block (Anthropic). Stable content goes first. */
  cache?: boolean
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: JSONSchema
  /** Provider-defined tool settings, passed through as-is (`{ type: "web_search_20260209" }`). */
  provider?: Record<string, unknown>
}

export type ToolChoice = "auto" | "none" | "required" | { tool: string }

export interface ModelSettings {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  /** `low` to `max`. Drivers map it to the provider's reasoning or effort setting. */
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  /** Show reasoning summaries when the provider supports it. */
  reasoningSummary?: boolean
  /** Passed straight to the provider, keyed by provider name. */
  providerOptions?: Record<string, Record<string, unknown>>
  headers?: Record<string, string>
}

export interface ModelRequest {
  system: SystemBlock[]
  messages: ModelTurn[]
  tools: ToolSpec[]
  toolChoice?: ToolChoice
  /** Ask for JSON matching this schema (only when the driver has `structuredOutput`). */
  responseFormat?: { schema: JSONSchema; name?: string }
  settings: ModelSettings
  signal: AbortSignal
}

/** Provider-neutral conversation turns. Drivers translate these to their API's messages. */
export type ModelTurn =
  | { role: "user"; content: Array<ModelTextContent | ModelFileContent> }
  | {
      role: "assistant"
      /** Tool results appear here only for provider-executed tools. */
      content: Array<ModelTextContent | ModelReasoningContent | ModelToolCallContent | ModelToolResultContent>
    }
  | { role: "tool"; content: ModelToolResultContent[] }

export interface ModelTextContent {
  type: "text"
  text: string
  /** Prompt-cache breakpoint after this block. */
  cache?: boolean
}
export interface ModelFileContent {
  type: "file"
  mediaType: string
  /** URL (https or data:) or base64. */
  data: string
  filename?: string
}
export interface ModelReasoningContent {
  type: "reasoning"
  text: string
  providerMetadata?: Record<string, unknown>
}
export interface ModelToolCallContent {
  type: "tool-call"
  toolCallId: string
  toolName: string
  input: unknown
  providerExecuted?: boolean
  providerMetadata?: Record<string, unknown>
}
export interface ModelToolResultContent {
  type: "tool-result"
  toolCallId: string
  toolName: string
  output: ToolResultContent
  isError?: boolean
}

/** What a tool returns to the model: text, JSON, or content blocks with images. */
export type ToolResultContent =
  | { type: "text"; value: string }
  | { type: "json"; value: unknown }
  | { type: "content"; value: Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; data: string }> }

export type ModelFinishReason = "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other"

export type ModelEvent =
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string; providerMetadata?: Record<string, unknown> }
  | { type: "reasoning-end"; id: string; providerMetadata?: Record<string, unknown> }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      input: unknown
      /** Ran on the provider's side (web search); a `tool-result` follows. */
      providerExecuted?: boolean
      providerMetadata?: Record<string, unknown>
    }
  | { type: "tool-result"; toolCallId: string; toolName: string; output: unknown; isError?: boolean; providerMetadata?: Record<string, unknown> }
  | { type: "source"; url: string; title?: string }
  | { type: "file"; mediaType: string; data: string }
  | { type: "finish"; finishReason: ModelFinishReason; usage: Usage; providerMetadata?: Record<string, unknown> }
  | { type: "error"; error: unknown }

// ---------------------------------------------------------------------------------------------
// Harness drivers

export interface HarnessDriver {
  readonly kind: "harness"
  readonly provider: string
  readonly modelId?: string
  /** Features the harness handles itself, so ai-kit doesn't add its own versions. */
  readonly handles?: {
    compaction?: boolean
    subagents?: boolean
    skills?: boolean
  }
  run(request: HarnessRequest): AsyncIterable<HarnessEvent>
}

export interface HarnessRequest {
  /** The new user message. */
  input: Message
  /** The conversation so far, for harnesses that can't resume. */
  history: Message[]
  /** The harness's own session id from an earlier turn, to resume. */
  resumeId?: string
  /** Resume `resumeId` into a new harness session instead of continuing it. */
  fork?: boolean
  system: string
  /** ai-kit tools to expose. `execute` runs the full permission and hook pipeline. */
  tools: BridgedTool[]
  /** Ask ai-kit whether a harness-native tool (Bash, Edit) may run. */
  canUseTool: (call: { toolCallId: string; toolName: string; input: unknown }) => Promise<HarnessPermission>
  output?: { schema: JSONSchema }
  settings: ModelSettings
  signal: AbortSignal
  /** App context from `send(..., { context })`. */
  context: unknown
}

export type HarnessPermission =
  | { behavior: "allow"; input?: unknown }
  | { behavior: "deny"; message: string }

export interface BridgedTool {
  spec: ToolSpec
  execute(input: unknown, call: { toolCallId: string; signal: AbortSignal }): Promise<{ output: ToolResultContent; isError: boolean }>
}

/**
 * Harness drivers emit AgentEvents for content (text, reasoning, native tool calls, steps) plus
 * a few of their own. Bridged ai-kit tools report their own events, so harnesses skip them.
 */
export type HarnessEvent =
  | Extract<
      AgentEvent,
      {
        type:
          | "step-start"
          | "text-delta"
          | "text-end"
          | "reasoning-delta"
          | "reasoning-end"
          | "tool-input-start"
          | "tool-input-delta"
          | "tool-call"
          | "tool-start"
          | "tool-progress"
          | "tool-result"
          | "step-finish"
          | "status"
          | "data"
          | "source"
          | "file"
        }
    >
  /** The harness's session id; ai-kit stores it to resume next turn. */
  | { type: "harness-session"; id: string }
  | { type: "finish"; finishReason: "stop" | "length" | "budget" | "error" | "aborted" | "max-steps"; usage: Usage; output?: unknown }
  | { type: "error"; error: { message: string; code?: string } }

export function isModelDriver(d: Driver): d is ModelDriver {
  return d.kind === "model"
}

export function isHarnessDriver(d: Driver): d is HarnessDriver {
  return d.kind === "harness"
}

export function driverLabel(d: Driver): string {
  return d.modelId ? `${d.provider}:${d.modelId}` : d.provider
}
