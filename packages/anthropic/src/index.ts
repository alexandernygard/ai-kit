import type {
  ModelCapabilities,
  ModelDriver,
  ModelEvent,
  ModelFinishReason,
  ModelRequest,
  ModelTurn,
  ToolResultContent,
  ToolSpec,
  Usage,
} from "@alexandernygard/ai-kit"
import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk"
import type {
  BetaCacheControlEphemeral,
  BetaClearToolUses20250919Edit,
  BetaCompact20260112Edit,
  BetaContextManagementConfig,
  BetaToolResultBlockParam,
  BetaContentBlockParam,
  BetaFallbacksParam,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaThinkingConfigParam,
  BetaToolChoice,
  BetaToolUnion,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages"
import { claudeModelInfo } from "./models"

export { CLAUDE_MODELS, claudeModelInfo, type ClaudeModelInfo } from "./models"

type Effort = NonNullable<NonNullable<MessageCreateParamsStreaming["output_config"]>["effort"]>

export interface ClaudeOptions {
  /** An Anthropic client (or a Bedrock / Vertex / Foundry one). Default: `new Anthropic(clientOptions)`. */
  client?: Pick<Anthropic, "beta">
  /** Options for the default client: `apiKey`, `baseURL`, `maxRetries`... Credentials come from the environment otherwise. */
  clientOptions?: ClientOptions
  capabilities?: ModelCapabilities
  /** `max_tokens` when the agent doesn't set `maxOutputTokens`. Default 64000. */
  maxTokens?: number
  /**
   * Prompt-cache breakpoints after the stable system prompt and on the newest message, so each
   * step reads the previous one from cache. Default true.
   */
  cache?: boolean | { ttl?: "5m" | "1h" }
  /** Thinking config. Omitted by default, which is adaptive on current models. `reasoningSummary` sets `display: "summarized"`. */
  thinking?: BetaThinkingConfigParam
  /**
   * Stream tool inputs as they're generated (`eager_input_streaming`). ai-kit validates every
   * input against the tool's schema before running it. Default true.
   */
  eagerInputStreaming?: boolean
  /**
   * Server-side fallback when the model declines for policy reasons: `"default"` or a model list.
   * Default `"default"` on Claude 5 models with the default client (the Claude API); `false` turns
   * it off. Bedrock, Vertex and Foundry clients don't support it.
   */
  fallbacks?: BetaFallbacksParam | false
  /**
   * Server-side compaction (`compact_20260112`): when the prompt reaches the trigger, the API
   * summarizes the earlier conversation and returns a compaction block that ai-kit stores and sends
   * back. The trigger defaults to the agent's `compaction.threshold` of the context window (at
   * least 50 000 tokens). Default on for models that support it; `false` turns it off and ai-kit
   * summarizes on its own instead.
   */
  compaction?: boolean | Omit<BetaCompact20260112Edit, "type">
  /** Server-side clearing of old tool results (`clear_tool_uses_20250919`). Off by default. */
  clearToolUses?: boolean | Omit<BetaClearToolUses20250919Edit, "type">
  /**
   * Server-side tool search for deferred tools (`defer: true` on a tool or toolkit). All tools are
   * declared up front and the model loads deferred ones by searching, so the tool list never
   * changes. Default `"bm25"`; `false` falls back to ai-kit's `search_tools`.
   */
  toolSearch?: "bm25" | "regex" | false
  /**
   * Mid-conversation `role: "system"` messages for context and ai-kit's instructions. Defaults to
   * the models that support them; others get the text in the user turn.
   */
  systemMessages?: boolean
  /**
   * What the API does with a thinking block whose conversation changed since it was produced
   * (`thinking.block_binding.prefix_mismatch_behavior`). ai-kit keeps history append-only, so this
   * is a safety net: `"drop_block"` (default on models with preserved thinking) drops the stale
   * reasoning instead of failing the request. `false` leaves it unset.
   */
  thinkingBinding?: "drop_block" | "error" | false
  /** Extra `anthropic-beta` flags sent on every request. */
  betas?: string[]
  /** Merged into every request body, after everything else. */
  params?: Partial<MessageCreateParamsStreaming>
  /** Resume a `pause_turn` (long server-tool turns) this many times per step. Default 5. */
  maxPauseResumes?: number
}

const FALLBACK_BETA = { list: "server-side-fallback-2026-06-01", default: "server-side-fallback-2026-07-01" }
const COMPACTION_BETA = "compact-2026-01-12"
const CONTEXT_EDITING_BETA = "context-management-2025-06-27"
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"


/**
 * A ModelDriver for the Claude API through the official Anthropic SDK.
 *
 * ```ts
 * import { claude } from "@alexandernygard/ai-kit-anthropic"
 *
 * defineAgent({ name: "support", model: claude("claude-opus-5-5"), ... })
 * ```
 *
 * Credentials come from `ANTHROPIC_API_KEY` (or an `ant auth login` profile) unless you pass a
 * client. For server tools, put the tool definition in an ai-kit tool's `provider` field:
 *
 * ```ts
 * tool({ name: "web_search", description: "Search the web", provider: { type: "web_search_20260209", max_uses: 5 } })
 * ```
 */
export function claude(model: string, options: ClaudeOptions = {}): ModelDriver {
  let client = options.client
  const cache = options.cache ?? true
  const info = claudeModelInfo(model)
  const compaction = options.compaction ?? !!info.compaction
  const toolSearch = options.toolSearch ?? (info.toolSearch ? "bm25" : false)
  const systemMessages = options.systemMessages ?? !!info.systemMessages
  const binding = options.thinkingBinding ?? (info.preservedThinking ? "drop_block" : false)
  const fallbacks = options.fallbacks ?? (!options.client && info.fallbacks ? "default" : false)
  const cacheControl: BetaCacheControlEphemeral | undefined = cache
    ? { type: "ephemeral", ...(typeof cache === "object" && cache.ttl ? { ttl: cache.ttl } : {}) }
    : undefined

  return {
    kind: "model",
    provider: "anthropic",
    modelId: model,
    capabilities: {
      structuredOutput: true,
      promptCaching: true,
      images: true,
      pdf: true,
      reasoning: true,
      contextManagement: compaction !== false,
      toolSearch: toolSearch !== false,
      forcedToolChoice: info.forcedToolChoice !== false,
      ...options.capabilities,
    },
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      client ??= new Anthropic(options.clientOptions)
      const s = request.settings
      let thinking: BetaThinkingConfigParam | undefined = s.reasoningSummary
        ? { type: "adaptive", ...(options.thinking?.type === "adaptive" ? options.thinking : {}), display: "summarized" }
        : options.thinking
      if (binding && (!thinking || thinking.type === "adaptive")) {
        thinking = { type: "adaptive", ...thinking, block_binding: { prefix_mismatch_behavior: binding } } as BetaThinkingConfigParam
      }
      const outputConfig: MessageCreateParamsStreaming["output_config"] = {
        ...(s.effort ? { effort: (s.effort === "minimal" ? "low" : s.effort) as Effort } : {}),
        ...(request.responseFormat && !request.tools.length ? { format: { type: "json_schema" as const, schema: request.responseFormat.schema as Record<string, unknown> } } : {}),
      }
      const betas = [...(options.betas ?? [])]
      if (fallbacks) betas.push(fallbacks === "default" ? FALLBACK_BETA.default : FALLBACK_BETA.list)
      if (binding && thinking) betas.push(THINKING_BINDING_BETA)
      const contextManagement = toContextManagement(request, compaction, options.clearToolUses)
      if (contextManagement?.edits?.some((e) => e.type === "compact_20260112")) betas.push(COMPACTION_BETA)
      if (contextManagement?.edits?.some((e) => e.type !== "compact_20260112")) betas.push(CONTEXT_EDITING_BETA)

      const tools = toTools(request.tools, options.eagerInputStreaming ?? true, toolSearch)
      const messages = toAnthropicMessages(request.messages, cacheControl, { systemMessages })
      const params: MessageCreateParamsStreaming = {
        model,
        max_tokens: s.maxOutputTokens ?? options.maxTokens ?? 64_000,
        system: request.system.map((b) => ({ type: "text" as const, text: b.text, ...(b.cache && cacheControl ? { cache_control: cacheControl } : {}) })),
        messages,
        ...(tools.length ? { tools } : {}),
        ...(request.toolChoice !== undefined ? { tool_choice: toToolChoice(request.toolChoice) } : {}),
        ...(thinking ? { thinking } : {}),
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        ...(s.temperature !== undefined ? { temperature: s.temperature } : {}),
        ...(s.topP !== undefined ? { top_p: s.topP } : {}),
        ...(s.stopSequences?.length ? { stop_sequences: s.stopSequences } : {}),
        ...(fallbacks ? { fallbacks } : {}),
        ...(contextManagement ? { context_management: contextManagement } : {}),
        ...(betas.length ? { betas } : {}),
        ...options.params,
        ...(s.providerOptions?.anthropic as Partial<MessageCreateParamsStreaming> | undefined),
        stream: true,
      }

      const usage: Usage = { inputTokens: 0, outputTokens: 0 }
      let finishReason: ModelFinishReason = "other"
      try {
        for (let round = 0; ; round++) {
          const turn = yield* streamRound(client, params, request, round, usage)
          if (!turn) return
          finishReason = turn.finishReason
          // A long server-tool turn pauses (as does compaction with `pause_after_compaction`); send
          // the partial turn back and the model carries on.
          const paused = turn.stopReason === "pause_turn" || turn.stopReason === "compaction"
          if (!paused || round >= (options.maxPauseResumes ?? 5)) break
          params.messages = [...messages, { role: "assistant", content: turn.content }]
        }
      } catch (e) {
        if (request.signal.aborted) return
        yield { type: "error", error: e }
        return
      }
      yield { type: "finish", finishReason, usage }
    },
  }
}

interface Block {
  type: string
  start: Record<string, any>
  text: string
  signature?: string
  json: string
  citations: unknown[]
  compaction?: { content: string | null; encrypted_content: string | null }
}

/** One streamed request. Yields ModelEvents and returns the assistant content, for `pause_turn`. */
async function* streamRound(
  client: Pick<Anthropic, "beta">,
  params: MessageCreateParamsStreaming,
  request: ModelRequest,
  round: number,
  usage: Usage,
): AsyncGenerator<ModelEvent, { stopReason: string | null; finishReason: ModelFinishReason; content: BetaContentBlockParam[] } | undefined> {
  const stream = await client.beta.messages.create(params, { signal: request.signal, headers: request.settings.headers })
  const blocks = new Map<number, Block>()
  const serverTools = new Map<string, string>()
  const content: BetaContentBlockParam[] = []
  let stopReason: string | null = null
  // message_start has the input counts; message_delta updates them with cumulative totals.
  const roundUsage: Record<string, number | null | undefined> = {}
  const id = (index: number) => `${round}:${index}`
  let iterations: unknown[] | null | undefined

  for await (const event of stream as AsyncIterable<BetaRawMessageStreamEvent>) {
    switch (event.type) {
      case "message_start":
        Object.assign(roundUsage, event.message.usage)
        break
      case "content_block_start": {
        const start = event.content_block as Record<string, any>
        blocks.set(event.index, { type: start.type, start, text: "", json: "", citations: [] })
        if (start.type === "tool_use") yield { type: "tool-input-start", toolCallId: start.id, toolName: start.name }
        else if (start.type === "server_tool_use") serverTools.set(start.id, start.name)
        break
      }
      case "content_block_delta": {
        const b = blocks.get(event.index)
        if (!b) break
        const d = event.delta
        switch (d.type) {
          case "text_delta":
            b.text += d.text
            yield { type: "text-delta", id: id(event.index), delta: d.text }
            break
          case "thinking_delta":
            b.text += d.thinking
            yield { type: "reasoning-delta", id: id(event.index), delta: d.thinking }
            break
          case "signature_delta":
            b.signature = d.signature
            break
          case "input_json_delta":
            b.json += d.partial_json
            if (b.type === "tool_use") yield { type: "tool-input-delta", toolCallId: b.start.id, delta: d.partial_json }
            break
          case "compaction_delta":
            b.compaction = { content: d.content, encrypted_content: d.encrypted_content }
            break
          case "citations_delta": {
            b.citations.push(d.citation)
            const c = d.citation as { type: string; url?: string; title?: string | null }
            if (c.url) yield { type: "source", url: c.url, title: c.title ?? undefined }
            break
          }
        }
        break
      }
      case "content_block_stop": {
        const b = blocks.get(event.index)
        if (!b) break
        const block = finishBlock(b)
        if (block) content.push(block)
        switch (b.type) {
          case "text":
            yield { type: "text-end", id: id(event.index) }
            break
          case "thinking":
            yield { type: "reasoning-end", id: id(event.index), providerMetadata: { anthropic: { signature: b.signature ?? b.start.signature ?? "" } } }
            break
          case "redacted_thinking":
            yield { type: "reasoning-end", id: id(event.index), providerMetadata: { anthropic: { redactedData: b.start.data } } }
            break
          case "tool_use":
            yield { type: "tool-call", toolCallId: b.start.id, toolName: b.start.name, input: parseInput(b) }
            break
          case "server_tool_use":
            yield { type: "tool-call", toolCallId: b.start.id, toolName: b.start.name, input: parseInput(b), providerExecuted: true }
            break
          case "compaction":
            yield { type: "raw", provider: "anthropic", value: block, compaction: { summary: b.compaction?.content ?? b.start.content ?? "" } }
            break
          default:
            // Server tool results (web_search_tool_result, ...) arrive whole. The block itself is the
            // output, so it can be sent back unchanged next turn.
            if (typeof b.start.tool_use_id === "string") {
              const isError = isErrorResult(b.start)
              yield { type: "tool-result", toolCallId: b.start.tool_use_id, toolName: serverTools.get(b.start.tool_use_id) ?? b.type, output: b.start, isError }
            } else {
              // Anything else (a fallback boundary, an MCP call) is kept and sent back in place.
              yield { type: "raw", provider: "anthropic", value: block }
            }
        }
        break
      }
      case "message_delta":
        stopReason = event.delta.stop_reason
        for (const [k, v] of Object.entries(event.usage)) if (typeof v === "number") roundUsage[k] = v
        iterations = (event.usage as { iterations?: unknown[] | null }).iterations ?? iterations
        break
    }
  }
  if (request.signal.aborted) return undefined
  addUsage(usage, roundUsage)
  // The top-level counts leave out compaction; it's billed as its own iteration.
  for (const it of (iterations ?? []) as Array<Record<string, number | string | null | undefined>>) {
    if (it.type === "compaction") addUsage(usage, it as Record<string, number | null | undefined>)
  }
  return { stopReason, finishReason: mapStop(stopReason), content }
}

function finishBlock(b: Block): BetaContentBlockParam | undefined {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text, ...(b.citations.length ? { citations: b.citations as never } : {}) }
    case "thinking":
      return { type: "thinking", thinking: b.text, signature: b.signature ?? b.start.signature ?? "" }
    case "redacted_thinking":
      return { type: "redacted_thinking", data: b.start.data }
    case "compaction":
      return {
        ...b.start,
        type: "compaction",
        content: b.compaction?.content ?? b.start.content ?? null,
        encrypted_content: b.compaction?.encrypted_content ?? b.start.encrypted_content ?? null,
        ...(b.signature ? { signature: b.signature } : {}),
      } as BetaContentBlockParam
    case "tool_use":
    case "server_tool_use": {
      const input = parseInput(b)
      return { ...b.start, input: isObject(input) ? input : {} } as BetaContentBlockParam
    }
    default:
      return b.start as BetaContentBlockParam
  }
}

/** The streamed tool input. Unparseable JSON stays a string so schema validation rejects it. */
function parseInput(b: Block): unknown {
  if (!b.json) return isObject(b.start.input) ? b.start.input : {}
  try {
    return JSON.parse(b.json)
  } catch {
    return b.json
  }
}

function isErrorResult(block: Record<string, any>): boolean {
  const c = block.content
  return !!c && !Array.isArray(c) && typeof c === "object" && typeof c.type === "string" && c.type.endsWith("_error")
}

/** Adds one request's usage. Anthropic's `input_tokens` excludes cached tokens, as ai-kit's does. */
function addUsage(u: Usage, x: Record<string, number | null | undefined>) {
  u.inputTokens += x.input_tokens ?? 0
  u.outputTokens += x.output_tokens ?? 0
  if (x.cache_read_input_tokens != null) u.cacheReadTokens = (u.cacheReadTokens ?? 0) + x.cache_read_input_tokens
  if (x.cache_creation_input_tokens != null) u.cacheWriteTokens = (u.cacheWriteTokens ?? 0) + x.cache_creation_input_tokens
}

function mapStop(reason: string | null): ModelFinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    case "compaction":
      return "stop"
    case "tool_use":
      return "tool-calls"
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length"
    case "refusal":
      return "content-filter"
    default:
      return "other"
  }
}

function toTools(specs: ToolSpec[], eager: boolean, search: ClaudeOptions["toolSearch"] = false): BetaToolUnion[] {
  const tools = specs.map((t) => toTool(t, eager, !!search))
  // Deferred tools need the search tool, which itself is never deferred.
  if (search && specs.some((t) => t.defer)) {
    tools.push(
      search === "regex"
        ? { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" }
        : { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
    )
  }
  return tools
}

function toTool(t: ToolSpec, eager: boolean, search: boolean): BetaToolUnion {
  const defer = search && t.defer ? { defer_loading: true } : {}
  if (t.provider) return { name: t.name, ...t.provider, ...defer } as BetaToolUnion
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as never,
    ...(eager ? { eager_input_streaming: true } : {}),
    ...defer,
  }
}

function toContextManagement(
  request: ModelRequest,
  compaction: ClaudeOptions["compaction"],
  clearToolUses: ClaudeOptions["clearToolUses"],
): BetaContextManagementConfig | undefined {
  const edits: NonNullable<BetaContextManagementConfig["edits"]> = []
  if (clearToolUses) edits.push({ type: "clear_tool_uses_20250919", ...(clearToolUses === true ? {} : clearToolUses) })
  if (compaction && request.contextManagement !== false) {
    const opts = compaction === true ? {} : compaction
    const at = request.contextManagement?.compactAtTokens
    edits.push({
      type: "compact_20260112",
      ...(at ? { trigger: { type: "input_tokens", value: Math.max(50_000, at) } } : {}),
      ...(request.contextManagement?.instructions ? { instructions: request.contextManagement.instructions } : {}),
      ...opts,
    })
  }
  return edits.length ? { edits } : undefined
}

function toToolChoice(c: NonNullable<ModelRequest["toolChoice"]>): BetaToolChoice {
  // Forced choices ("required", a named tool) return a 400 on Claude Opus 5.5, Sonnet 5.5 and Fable 5.1.
  if (c === "auto") return { type: "auto" }
  if (c === "none") return { type: "none" }
  if (c === "required") return { type: "any" }
  return { type: "tool", name: c.tool }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isUrl = (s: string) => /^https?:/i.test(s)

/** Splits a `data:` URL; plain strings are treated as base64. */
function base64Of(data: string): string {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(data)
  return m ? m[1]! : data
}

function fileBlock(c: Extract<Extract<ModelTurn, { role: "user" }>["content"][number], { type: "file" }>): BetaContentBlockParam {
  const media = c.mediaType
  if (media.startsWith("image/")) {
    return isUrl(c.data)
      ? { type: "image", source: { type: "url", url: c.data } }
      : { type: "image", source: { type: "base64", media_type: media as "image/png", data: base64Of(c.data) } }
  }
  if (media === "application/pdf") {
    return isUrl(c.data)
      ? { type: "document", source: { type: "url", url: c.data }, ...(c.filename ? { title: c.filename } : {}) }
      : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Of(c.data) }, ...(c.filename ? { title: c.filename } : {}) }
  }
  if (media.startsWith("text/") && !isUrl(c.data)) {
    const text = c.data.startsWith("data:") ? decodeBase64(base64Of(c.data)) : c.data
    return { type: "document", source: { type: "text", media_type: "text/plain", data: text }, ...(c.filename ? { title: c.filename } : {}) }
  }
  return { type: "text", text: `[Attached file${c.filename ? ` ${c.filename}` : ""} (${media}) can't be shown to the model.]` }
}

function decodeBase64(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0)))
}

function toolResultContent(o: ToolResultContent): BetaToolResultBlockParam["content"] {
  if (o.type === "text") return o.value
  if (o.type === "json") return JSON.stringify(o.value ?? null)
  return o.value.map((v) =>
    v.type === "text"
      ? { type: "text" as const, text: v.text }
      : { type: "image" as const, source: { type: "base64" as const, media_type: v.mediaType as "image/png", data: base64Of(v.data) } },
  )
}

/**
 * After a mid-output fallback, thinking, tool calls and unpaired server tool calls from before
 * the last `fallback` block came from the model that declined, and the API rejects them.
 */
function dropBeforeFallback(content: BetaContentBlockParam[], dropped: Set<string>): BetaContentBlockParam[] {
  const boundary = content.findLastIndex((b) => b.type === "fallback")
  if (boundary <= 0) return content
  const resultIds = new Set(content.map((b) => (b as { tool_use_id?: string }).tool_use_id).filter(Boolean))
  return content.filter((b, i) => {
    if (i > boundary) return true
    if (b.type === "thinking" || b.type === "redacted_thinking") return false
    if (b.type === "tool_use") return (dropped.add(b.id), false)
    if (b.type === "server_tool_use") return resultIds.has(b.id)
    return true
  })
}

const CACHEABLE = new Set(["text", "image", "document", "tool_use", "tool_result", "server_tool_use", "search_result"])

/**
 * ai-kit turns to Messages API messages. Exported for tests and custom drivers.
 * `systemMessages: false` sends system turns as user text, for models without `role: "system"` messages.
 */
export function toAnthropicMessages(
  turns: ModelTurn[],
  cacheControl?: BetaCacheControlEphemeral,
  options: { systemMessages?: boolean } = {},
): BetaMessageParam[] {
  const out: BetaMessageParam[] = []
  // Tool calls left out of a turn that fell back mid-output; their results go too.
  const dropped = new Set<string>()
  const push = (role: "user" | "assistant" | "system", content: BetaContentBlockParam[]) => {
    if (!content.length) return
    // Tool results and the user text after them share one user turn.
    const last = out.at(-1)
    if (last?.role === role && Array.isArray(last.content)) last.content.push(...content)
    else out.push({ role, content })
  }

  for (const t of turns) {
    switch (t.role) {
      case "system":
        if (options.systemMessages !== false) push("system", t.content.map((c) => ({ type: "text" as const, text: c.text })))
        else push("user", t.content.map((c) => ({ type: "text" as const, text: `<system>\n${c.text}\n</system>` })))
        break
      case "user":
        push(
          "user",
          t.content.map((c) => (c.type === "text" ? { type: "text" as const, text: c.text } : fileBlock(c))),
        )
        break
      case "tool":
        push(
          "user",
          t.content.filter((c) => !dropped.has(c.toolCallId)).map((c) => ({
            type: "tool_result" as const,
            tool_use_id: c.toolCallId,
            content: toolResultContent(c.output),
            ...(c.isError ? { is_error: true } : {}),
          })),
        )
        break
      case "assistant": {
        const results = new Map<string, Record<string, unknown>>()
        for (const c of t.content) {
          if (c.type === "tool-result" && c.output.type === "json" && isObject(c.output.value) && c.output.value.tool_use_id === c.toolCallId) {
            results.set(c.toolCallId, c.output.value)
          }
        }
        const content: BetaContentBlockParam[] = []
        for (const c of t.content) {
          switch (c.type) {
            case "text":
              if (c.text) content.push({ type: "text", text: c.text })
              break
            case "reasoning": {
              const meta = c.providerMetadata?.anthropic as { signature?: string; redactedData?: string } | undefined
              // Thinking is only valid with its signature; unsigned reasoning can't be sent back.
              if (meta?.redactedData) content.push({ type: "redacted_thinking", data: meta.redactedData })
              else if (meta?.signature) content.push({ type: "thinking", thinking: c.text, signature: meta.signature })
              break
            }
            case "tool-call":
              if (c.providerExecuted) {
                // A server tool call goes back with its result block, or not at all.
                if (results.has(c.toolCallId)) {
                  content.push({ type: "server_tool_use", id: c.toolCallId, name: c.toolName as never, input: isObject(c.input) ? c.input : {} })
                }
              } else content.push({ type: "tool_use", id: c.toolCallId, name: c.toolName, input: isObject(c.input) ? c.input : {} })
              break
            case "tool-result": {
              const block = results.get(c.toolCallId)
              if (block) content.push(block as unknown as BetaContentBlockParam)
              break
            }
            case "raw":
              if (c.provider === "anthropic") content.push(c.value as BetaContentBlockParam)
              break
          }
        }
        push("assistant", dropBeforeFallback(content, dropped))
        break
      }
    }
  }

  // Cache everything up to the newest message so the next step reads it from cache.
  if (cacheControl) {
    const last = out.at(-1)
    if (last && Array.isArray(last.content)) {
      const block = [...last.content].reverse().find((b) => CACHEABLE.has(b.type)) as { cache_control?: BetaCacheControlEphemeral } | undefined
      if (block) block.cache_control = cacheControl
    }
  }
  return out
}
