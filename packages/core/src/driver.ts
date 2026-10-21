import type { AgentEvent } from "./events"
import type { Message } from "./messages"
import type { JSONSchema } from "./schema"
import type { Usage } from "./usage"

/*
 * A driver connects ai-kit to a model. It makes one model call; ai-kit runs the agent loop
 * around it (tools, approvals, client tools, code mode, tool search, compaction, hooks).
 * `claude()` from `@alexandernygard/ai-kit-anthropic` is the Claude API driver; `aiSdk()` covers
 * every AI SDK provider.
 */

export type Driver = ModelDriver

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
  /**
   * The provider compacts and trims the context itself (Claude's server-side compaction).
   * ai-kit then leaves the history alone instead of summarizing or clearing tool outputs.
   */
  contextManagement?: boolean
  /** The provider searches deferred tools itself. ai-kit sends them with `defer: true` and adds no `search_tools`. */
  toolSearch?: boolean
  /**
   * `false` when the model rejects a forced `toolChoice` ("required" or a named tool). ai-kit then
   * sends "auto" and tells the model which tool to use in a system message.
   */
  forcedToolChoice?: boolean
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
  /** Loaded only when the model finds it with the provider's tool search (needs `capabilities.toolSearch`). */
  defer?: boolean
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
  /**
   * For drivers with `capabilities.contextManagement`: when to compact (input tokens) and with
   * which instructions. `false` turns it off.
   */
  contextManagement?: false | { compactAtTokens?: number; instructions?: string }
  signal: AbortSignal
}

/**
 * Provider-neutral conversation turns. Drivers translate these to their API's messages.
 * ai-kit only ever appends to them: earlier turns go out byte for byte the same on every request,
 * which keeps the prompt cache warm and Claude's thinking valid.
 */
export type ModelTurn =
  /** Operator text in the middle of the conversation (context, instructions). Drivers without system messages send it as user text. */
  | { role: "system"; content: ModelTextContent[] }
  | { role: "user"; content: Array<ModelTextContent | ModelFileContent> }
  | {
      role: "assistant"
      /** Tool results appear here only for provider-executed tools. */
      content: Array<ModelTextContent | ModelReasoningContent | ModelToolCallContent | ModelToolResultContent | ModelRawContent>
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
/** A provider block ai-kit doesn't model (a compaction summary, a fallback boundary). Sent back in place. */
export interface ModelRawContent {
  type: "raw"
  provider: string
  value: unknown
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
  /**
   * A provider block to keep in the message and send back in place next time. `compaction` is set
   * when the provider compacted the conversation, with the summary.
   */
  | { type: "raw"; provider: string; value: unknown; compaction?: { summary: string } }
  | { type: "file"; mediaType: string; data: string }
  | { type: "finish"; finishReason: ModelFinishReason; usage: Usage; providerMetadata?: Record<string, unknown> }
  | { type: "error"; error: unknown }

export function isModelDriver(d: Driver): d is ModelDriver {
  return d.kind === "model"
}

export function driverLabel(d: Driver): string {
  return d.modelId ? `${d.provider}:${d.modelId}` : d.provider
}
