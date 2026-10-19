import type {
  ModelCapabilities,
  ModelDriver,
  ModelEvent,
  ModelFinishReason,
  ModelRequest,
  ModelTurn,
  ToolResultContent,
  Usage,
} from "@alexandernygard/ai-kit"
import { jsonSchema, type LanguageModel, type ModelMessage, streamText, tool, type ToolSet } from "ai"

type ProviderOptions = Record<string, Record<string, any>>

export interface AiSdkOptions {
  /** Provider name for logs and pricing. Read from the model when it's a model object. */
  provider?: string
  capabilities?: ModelCapabilities
  /**
   * Prompt-cache breakpoints on Anthropic models: after the stable system prompt and on the
   * latest message, so each turn reuses the previous one's cache. Default true.
   */
  cache?: boolean | { ttl?: "5m" | "1h" }
  /** Merged into every call's provider options. */
  providerOptions?: ProviderOptions
  /** Retries on rate limits and server errors (AI SDK default 2). */
  maxRetries?: number
}

/**
 * A ModelDriver for any AI SDK language model.
 *
 * ```ts
 * import { anthropic } from "@ai-sdk/anthropic"
 * import { openai } from "@ai-sdk/openai"
 *
 * const claude = aiSdk(anthropic("claude-opus-5-5"))
 * const gpt = aiSdk(openai("gpt-5.5"))
 * const viaGateway = aiSdk("anthropic/claude-sonnet-5-5") // AI Gateway model string
 * ```
 *
 * For provider-executed tools (web search, code execution), put the AI SDK tool object in an
 * ai-kit tool's `provider` field:
 *
 * ```ts
 * tool({ name: "web_search", description: "Search the web", provider: anthropic.tools.webSearch_20260209({ maxUses: 5 }) })
 * ```
 */
export function aiSdk(model: LanguageModel, options: AiSdkOptions = {}): ModelDriver {
  const modelId = typeof model === "string" ? model : model.modelId
  const provider = options.provider ?? (typeof model === "string" ? (model.split("/")[0] ?? "gateway") : model.provider.split(".")[0]!)
  const isAnthropic = /anthropic|claude/i.test(typeof model === "string" ? model : `${model.provider} ${model.modelId}`)
  const cache = options.cache ?? true
  const cacheControl = isAnthropic && cache ? { type: "ephemeral" as const, ...(typeof cache === "object" && cache.ttl ? { ttl: cache.ttl } : {}) } : undefined

  return {
    kind: "model",
    provider,
    modelId: typeof model === "string" ? (model.split("/").slice(1).join("/") || model) : modelId,
    capabilities: { structuredOutput: true, ...options.capabilities },
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const s = request.settings
      const providerOptions = mergeOptions(options.providerOptions, s.providerOptions)
      if (isAnthropic && s.reasoningSummary) {
        providerOptions.anthropic = { thinking: { type: "adaptive", display: "summarized" }, ...providerOptions.anthropic }
      }
      const result = streamText({
        model,
        system: request.system.map((b) => ({
          role: "system" as const,
          content: b.text,
          providerOptions: b.cache && cacheControl ? { anthropic: { cacheControl } } : undefined,
        })),
        messages: toModelMessages(request.messages, cacheControl),
        tools: toToolSet(request),
        toolChoice:
          request.toolChoice === undefined
            ? undefined
            : typeof request.toolChoice === "string"
              ? request.toolChoice
              : { type: "tool", toolName: request.toolChoice.tool },
        maxOutputTokens: s.maxOutputTokens,
        temperature: s.temperature,
        topP: s.topP,
        stopSequences: s.stopSequences,
        reasoning: s.effort,
        headers: s.headers,
        providerOptions: Object.keys(providerOptions).length ? providerOptions : undefined,
        maxRetries: options.maxRetries,
        abortSignal: request.signal,
        ...(request.responseFormat && !request.tools.length
          ? { output: (await import("ai")).Output.object({ schema: jsonSchema(request.responseFormat.schema as never) }) }
          : {}),
      } as Parameters<typeof streamText>[0])

      let finished = false
      for await (const part of result.fullStream as AsyncIterable<any>) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text-delta", id: part.id, delta: part.text }
            break
          case "text-end":
            yield { type: "text-end", id: part.id }
            break
          case "reasoning-delta":
            yield { type: "reasoning-delta", id: part.id, delta: part.text, providerMetadata: part.providerMetadata }
            break
          case "reasoning-end":
            yield { type: "reasoning-end", id: part.id, providerMetadata: part.providerMetadata }
            break
          case "tool-input-start":
            if (!part.providerExecuted) yield { type: "tool-input-start", toolCallId: part.id, toolName: part.toolName }
            break
          case "tool-input-delta":
            yield { type: "tool-input-delta", toolCallId: part.id, delta: part.delta }
            break
          case "tool-call":
            yield {
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              providerExecuted: part.providerExecuted,
              providerMetadata: part.providerMetadata,
            }
            break
          case "tool-result":
            if (part.providerExecuted) {
              yield { type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.output, providerMetadata: part.providerMetadata }
            }
            break
          case "tool-error":
            if (part.providerExecuted) {
              yield { type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: errorText(part.error), isError: true }
            }
            break
          case "source":
            if (part.sourceType === "url") yield { type: "source", url: part.url, title: part.title }
            break
          case "file":
            yield { type: "file", mediaType: part.file.mediaType, data: part.file.base64 }
            break
          case "finish":
            finished = true
            yield { type: "finish", finishReason: mapFinish(part.finishReason), usage: mapUsage(part.totalUsage) }
            break
          case "error":
            yield { type: "error", error: part.error }
            return
          case "abort":
            return
        }
      }
      if (!finished && !request.signal.aborted) yield { type: "finish", finishReason: "other", usage: { inputTokens: 0, outputTokens: 0 } }
    },
  }
}

function mergeOptions(...opts: Array<ProviderOptions | undefined>): ProviderOptions {
  const out: ProviderOptions = {}
  for (const o of opts) for (const [k, v] of Object.entries(o ?? {})) out[k] = { ...out[k], ...v }
  return out
}

function toToolSet(request: ModelRequest): ToolSet | undefined {
  if (!request.tools.length) return undefined
  const set: ToolSet = {}
  for (const t of request.tools) {
    set[t.name] = t.provider
      ? (t.provider as ToolSet[string])
      : tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema as never) })
  }
  return set
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e)
}

function mapFinish(reason: string): ModelFinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
      return reason
    default:
      return "other"
  }
}

function mapUsage(u: any): Usage {
  return {
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens,
    cacheWriteTokens: u?.inputTokenDetails?.cacheWriteTokens,
    reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? u?.reasoningTokens,
  }
}

const isUrl = (s: string) => /^(https?|data):/i.test(s)

/** ai-kit turns to AI SDK model messages. Exported for tests and custom drivers. */
export function toModelMessages(turns: ModelTurn[], cacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" }): ModelMessage[] {
  const out: ModelMessage[] = turns.map((t): ModelMessage => {
    switch (t.role) {
      case "user":
        return {
          role: "user",
          content: t.content.map((c) => {
            if (c.type === "text") return { type: "text" as const, text: c.text }
            if (c.mediaType.startsWith("image/")) {
              return { type: "image" as const, image: isUrl(c.data) ? new URL(c.data) : c.data, mediaType: c.mediaType }
            }
            return { type: "file" as const, data: isUrl(c.data) ? new URL(c.data) : c.data, mediaType: c.mediaType, filename: c.filename }
          }),
        }
      case "assistant":
        return {
          role: "assistant",
          content: t.content.map((c) => {
            switch (c.type) {
              case "text":
                return { type: "text" as const, text: c.text }
              case "reasoning":
                return { type: "reasoning" as const, text: c.text, providerOptions: c.providerMetadata as never }
              case "tool-call":
                return {
                  type: "tool-call" as const,
                  toolCallId: c.toolCallId,
                  toolName: c.toolName,
                  input: c.input,
                  providerExecuted: c.providerExecuted || undefined,
                  providerOptions: c.providerMetadata as never,
                }
              case "tool-result":
                return { type: "tool-result" as const, toolCallId: c.toolCallId, toolName: c.toolName, output: toOutput(c.output, c.isError) }
            }
          }),
        } as ModelMessage
      case "tool":
        return {
          role: "tool",
          content: t.content.map((c) => ({ type: "tool-result" as const, toolCallId: c.toolCallId, toolName: c.toolName, output: toOutput(c.output, c.isError) })),
        } as ModelMessage
    }
  })
  // Cache everything up to the newest message so the next turn reads it from cache.
  if (cacheControl) {
    const last = out.at(-1)
    if (last && Array.isArray(last.content) && last.content.length) {
      const part = last.content.at(-1) as { providerOptions?: ProviderOptions }
      part.providerOptions = { ...part.providerOptions, anthropic: { ...part.providerOptions?.anthropic, cacheControl } }
    }
  }
  return out
}

function toOutput(o: ToolResultContent, isError?: boolean): any {
  if (o.type === "text") return isError ? { type: "error-text", value: o.value } : { type: "text", value: o.value }
  if (o.type === "json") return isError ? { type: "error-json", value: o.value ?? null } : { type: "json", value: o.value ?? null }
  return {
    type: "content",
    value: o.value.map((v) =>
      v.type === "text" ? { type: "text", text: v.text } : { type: "file", data: { type: "data", data: v.data }, mediaType: v.mediaType },
    ),
  }
}
