import type { BridgedTool, HarnessDriver, HarnessEvent, HarnessRequest, Message, Usage } from "@alexandernygard/ai-kit"
import { createMcpServer } from "@alexandernygard/ai-kit-mcp"
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

export type ClaudeQuery = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query

export interface ClaudeAgentOptions {
  /** e.g. `claude-opus-5-5`, or an alias like `opus`. Default: Claude Code's default. */
  model?: string
  /**
   * Claude Code's built-in tools. Default `[]`: none, so the agent only has your ai-kit tools,
   * which suits app agents. `"claude_code"` gives the full coding toolset (Read, Edit, Bash...).
   */
  builtinTools?: string[] | "claude_code"
  /** Use Claude Code's own system prompt with yours appended. Good for coding agents. */
  claudeCodePrompt?: boolean
  /** Working directory for file and shell tools. */
  cwd?: string
  /** Claude Code permission mode for built-in tools. ai-kit's permissions run on top. */
  permissionMode?: Options["permissionMode"]
  /**
   * Which settings files Claude Code loads (`user`, `project`, `local`). Default `[]`, so a
   * server doesn't pick up whatever is in the machine's ~/.claude.
   */
  settingSources?: Options["settingSources"]
  /** Extra MCP servers for Claude Code itself. */
  mcpServers?: Options["mcpServers"]
  /** Claude Code subagents (its own Task tool). ai-kit subagents work too, through the bridge. */
  agents?: Options["agents"]
  maxTurns?: number
  maxBudgetUsd?: number
  /** The model's context window, for context-usage readings. Default: from the model id. */
  contextWindow?: number
  /**
   * Environment for the Claude Code process. To use your Claude subscription on a server, set
   * `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`; locally, `claude login` is enough.
   * Set `ANTHROPIC_API_KEY` to bill the API instead.
   */
  env?: Record<string, string | undefined>
  /** Anything else for `query()`, passed through. */
  extra?: Partial<Options>
  /** Swap the SDK's `query` (tests, or a pinned SDK). */
  query?: ClaudeQuery
}

const BRIDGE = "ai_kit"
const BRIDGE_PREFIX = `mcp__${BRIDGE}__`

/**
 * Run ai-kit agents on the Claude Agent SDK (Claude Code as a library).
 *
 * Uses whatever Claude Code is logged in with, so a Claude Pro or Max subscription works
 * without an API key. Anthropic's terms allow subscription use for your own work; for apps
 * that serve other people, use an API key (`env: { ANTHROPIC_API_KEY }`).
 *
 * ```ts
 * defineAgent({ name: "assistant", model: claudeAgent({ model: "claude-opus-5-5" }), tools: [...] })
 * defineAgent({ name: "coder", model: claudeAgent({ builtinTools: "claude_code", claudeCodePrompt: true, cwd: repo }) })
 * ```
 */
export function claudeAgent(options: ClaudeAgentOptions = {}): HarnessDriver {
  return {
    kind: "harness",
    provider: "claude-agent",
    modelId: options.model,
    contextWindow: options.contextWindow,
    handles: { compaction: true },
    run: (req) => runClaude(req, options),
  }
}

async function* runClaude(req: HarnessRequest, o: ClaudeAgentOptions): AsyncGenerator<HarnessEvent> {
  const query = o.query ?? (await import("@anthropic-ai/claude-agent-sdk")).query
  const abort = new AbortController()
  const onAbort = () => abort.abort()
  req.signal.addEventListener("abort", onAbort, { once: true })

  // Model tool_use ids for bridged calls, so ai-kit's tool events use the same ids.
  const pendingIds = new Map<string, string[]>()
  const bridged: BridgedTool[] = req.tools.map((t) => ({
    spec: t.spec,
    execute: (input, call) => {
      const id = pendingIds.get(t.spec.name)?.shift() ?? call.toolCallId
      return t.execute(input, { ...call, toolCallId: id })
    },
  }))
  const servers: Options["mcpServers"] = { ...o.mcpServers }
  if (bridged.length) {
    servers[BRIDGE] = { type: "sdk", name: BRIDGE, instance: createMcpServer(bridged, { name: BRIDGE }) }
  }

  const system = withHistory(req.system, req.resumeId ? [] : req.history)
  const options: Options = {
    model: o.model,
    cwd: o.cwd,
    tools: o.builtinTools === "claude_code" ? { type: "preset", preset: "claude_code" } : (o.builtinTools ?? []),
    systemPrompt: o.claudeCodePrompt ? { type: "preset", preset: "claude_code", append: system || undefined } : system || undefined,
    mcpServers: servers,
    permissionMode: o.permissionMode,
    settingSources: o.settingSources ?? [],
    agents: o.agents,
    maxTurns: o.maxTurns,
    maxBudgetUsd: o.maxBudgetUsd,
    env: o.env ? { ...process.env, ...o.env } : undefined,
    resume: req.resumeId,
    forkSession: req.fork || undefined,
    includePartialMessages: true,
    abortController: abort,
    effort: req.settings.effort && req.settings.effort !== "minimal" ? req.settings.effort : undefined,
    outputFormat: req.output ? { type: "json_schema", schema: req.output.schema as Record<string, unknown> } : undefined,
    canUseTool: async (toolName, input, { toolUseID }) => {
      if (toolName.startsWith(BRIDGE_PREFIX)) return { behavior: "allow", updatedInput: input }
      const d = await req.canUseTool({ toolCallId: toolUseID, toolName, input })
      return d.behavior === "allow"
        ? { behavior: "allow", updatedInput: (d.input as Record<string, unknown> | undefined) ?? input }
        : { behavior: "deny", message: d.message }
    },
    ...o.extra,
  }

  const q = query({ prompt: toPrompt(req.input), options })
  const state = new StreamState(pendingIds)
  try {
    for await (const msg of q) {
      for (const e of state.map(msg)) yield e
      if (state.done) break
    }
    if (!state.done && !req.signal.aborted) {
      yield { type: "finish", finishReason: "error", usage: state.usage }
    }
  } catch (e) {
    if (req.signal.aborted) yield { type: "finish", finishReason: "aborted", usage: state.usage }
    else yield { type: "error", error: { message: e instanceof Error ? e.message : String(e) } }
  } finally {
    req.signal.removeEventListener("abort", onAbort)
  }
}

/** Without a session to resume (first turn after switching agents), give the history as text. */
function withHistory(system: string, history: Message[]): string {
  if (!history.length) return system
  const lines = history.map((m) => {
    const text = m.parts
      .map((p) => (p.type === "text" ? p.text : p.type === "tool" ? `[${p.toolName}: ${JSON.stringify(p.output ?? p.error ?? "").slice(0, 500)}]` : ""))
      .filter(Boolean)
      .join("\n")
    return `${m.role === "user" ? "User" : "Assistant"}: ${text}`
  })
  return `${system}\n\n<earlier_conversation>\n${lines.join("\n\n")}\n</earlier_conversation>`
}

function toPrompt(message: Message): string | AsyncIterable<SDKUserMessage> {
  const files = message.parts.filter((p) => p.type === "file")
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
  if (!files.length) return text
  const content: Array<Record<string, unknown>> = []
  for (const f of files) {
    if (f.type !== "file") continue
    const data = f.data ?? (f.url?.startsWith("data:") ? f.url.slice(f.url.indexOf(",") + 1) : undefined)
    const source = data ? { type: "base64", media_type: f.mediaType, data } : { type: "url", url: f.url }
    content.push({ type: f.mediaType.startsWith("image/") ? "image" : "document", source })
  }
  content.push({ type: "text", text })
  return (async function* () {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null } as unknown as SDKUserMessage
  })()
}

interface Block {
  kind: "text" | "thinking" | "tool"
  id: string
  name?: string
  json?: string
}

/** Turns SDK messages into harness events. */
class StreamState {
  usage: Usage = { inputTokens: 0, outputTokens: 0 }
  done = false
  private step = 0
  private blocks = new Map<number, Block>()
  private stepUsage: Usage = { inputTokens: 0, outputTokens: 0 }
  private streamedToolIds = new Set<string>()
  /** Bridged ai-kit calls: ai-kit reports their call and result itself. */
  private bridgedIds = new Set<string>()

  constructor(private readonly pendingIds: Map<string, string[]>) {}

  *map(msg: SDKMessage): Generator<HarnessEvent> {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") yield { type: "harness-session", id: msg.session_id }
        else if (msg.subtype === "compact_boundary") yield { type: "status", status: "compacting" }
        return
      case "stream_event":
        if (msg.parent_tool_use_id) return
        yield* this.streamEvent(msg.event as unknown as StreamEvent)
        return
      case "assistant": {
        if (msg.error) {
          yield { type: "error", error: { message: `Claude: ${msg.error}`, code: msg.error } }
          this.done = true
          return
        }
        // Full messages repeat what streamed. Only subagent tool calls (not streamed) are new.
        for (const block of msg.message.content as Array<Record<string, any>>) {
          if (block.type !== "tool_use" || this.streamedToolIds.has(block.id) || this.bridgedIds.has(block.id)) continue
          if (String(block.name).startsWith(BRIDGE_PREFIX)) {
            this.queueBridged(block.name, block.id)
            continue
          }
          this.streamedToolIds.add(block.id)
          yield {
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
            runtime: "harness",
            parentToolCallId: msg.parent_tool_use_id ?? undefined,
          }
        }
        return
      }
      case "user": {
        const content = (msg.message as { content?: unknown }).content
        if (!Array.isArray(content)) return
        for (const block of content as Array<Record<string, any>>) {
          if (block.type !== "tool_result" || !this.streamedToolIds.has(block.tool_use_id)) continue
          yield { type: "tool-result", toolCallId: block.tool_use_id, output: resultText(block.content), isError: !!block.is_error }
        }
        return
      }
      case "result": {
        this.done = true
        const u = msg.usage as unknown as RawUsage
        this.usage = { ...fromRaw(u), costUsd: msg.total_cost_usd }
        if (msg.subtype === "success") {
          yield { type: "finish", finishReason: "stop", usage: this.usage, output: msg.structured_output }
        } else {
          const reason = msg.subtype === "error_max_turns" ? "max-steps" : msg.subtype === "error_max_budget_usd" ? "budget" : "error"
          if (reason === "error") yield { type: "error", error: { message: msg.errors.join("\n") || msg.subtype, code: msg.subtype } }
          else yield { type: "finish", finishReason: reason, usage: this.usage }
        }
        return
      }
      default:
        return
    }
  }

  private queueBridged(name: string, id: string) {
    const short = name.slice(BRIDGE_PREFIX.length)
    const list = this.pendingIds.get(short) ?? []
    if (!list.includes(id) && !this.bridgedIds.has(id)) list.push(id)
    this.pendingIds.set(short, list)
    this.bridgedIds.add(id)
  }

  private *streamEvent(e: StreamEvent): Generator<HarnessEvent> {
    switch (e.type) {
      case "message_start":
        this.blocks.clear()
        this.stepUsage = fromRaw(e.message?.usage)
        yield { type: "step-start", step: this.step }
        return
      case "content_block_start": {
        const b = e.content_block
        const id = `${this.step}:${e.index}`
        if (b.type === "text") this.blocks.set(e.index, { kind: "text", id })
        else if (b.type === "thinking") this.blocks.set(e.index, { kind: "thinking", id })
        else if (b.type === "tool_use") {
          if (String(b.name).startsWith(BRIDGE_PREFIX)) {
            // ai-kit emits the call itself when it runs; announce it now so it shows in order.
            this.queueBridged(b.name, b.id)
            yield { type: "tool-input-start", toolCallId: b.id, toolName: String(b.name).slice(BRIDGE_PREFIX.length), runtime: "server" }
            return
          }
          this.blocks.set(e.index, { kind: "tool", id: b.id, name: b.name, json: "" })
          this.streamedToolIds.add(b.id)
          yield { type: "tool-input-start", toolCallId: b.id, toolName: b.name, runtime: "harness" }
        }
        return
      }
      case "content_block_delta": {
        const b = this.blocks.get(e.index)
        if (!b) return
        const d = e.delta
        if (d.type === "text_delta" && b.kind === "text") yield { type: "text-delta", partId: b.id, delta: d.text }
        else if (d.type === "thinking_delta" && b.kind === "thinking") yield { type: "reasoning-delta", partId: b.id, delta: d.thinking }
        else if (d.type === "input_json_delta" && b.kind === "tool") {
          b.json += d.partial_json
          yield { type: "tool-input-delta", toolCallId: b.id, delta: d.partial_json }
        }
        return
      }
      case "content_block_stop": {
        const b = this.blocks.get(e.index)
        if (!b) return
        if (b.kind === "text") yield { type: "text-end", partId: b.id }
        else if (b.kind === "thinking") yield { type: "reasoning-end", partId: b.id }
        else {
          let input: unknown = {}
          try {
            input = b.json ? JSON.parse(b.json) : {}
          } catch {
            input = { raw: b.json }
          }
          yield { type: "tool-call", toolCallId: b.id, toolName: b.name!, input, runtime: "harness" }
        }
        return
      }
      case "message_delta":
        if (e.usage?.output_tokens !== undefined) this.stepUsage = { ...this.stepUsage, outputTokens: e.usage.output_tokens }
        return
      case "message_stop":
        yield { type: "step-finish", step: this.step, usage: this.stepUsage, finishReason: "stop" }
        this.step++
        return
    }
  }
}

interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

type StreamEvent =
  | { type: "message_start"; message?: { usage?: RawUsage } }
  | { type: "content_block_start"; index: number; content_block: { type: string; id?: any; name?: any } }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: any; thinking?: any; partial_json?: any } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; usage?: RawUsage }
  | { type: "message_stop" }

function fromRaw(u: RawUsage | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? undefined,
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((c) => (c?.type === "text" ? c.text : `[${c?.type}]`)).join("\n")
  return JSON.stringify(content)
}
