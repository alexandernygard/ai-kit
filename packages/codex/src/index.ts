import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessDriver, HarnessEvent, HarnessRequest, Message, Usage } from "@alexandernygard/ai-kit"
import { createMcpServer, mcpHttpHandler } from "@alexandernygard/ai-kit-mcp"
import type { Codex, CodexOptions, Input, ThreadEvent, ThreadItem, ThreadOptions } from "@openai/codex-sdk"

export interface CodexDriverOptions {
  /** e.g. `gpt-5.5-codex`. Default: Codex's configured model. */
  model?: string
  /**
   * What Codex's shell may touch. Default `read-only`. Codex has no per-call approval hook in
   * its SDK, so the sandbox is how you limit its own tools; ai-kit tools keep ai-kit's
   * permissions and approvals.
   */
  sandboxMode?: ThreadOptions["sandboxMode"]
  workingDirectory?: string
  skipGitRepoCheck?: boolean
  networkAccessEnabled?: boolean
  webSearch?: ThreadOptions["webSearchMode"]
  additionalDirectories?: string[]
  /**
   * Codex client options. Leave `apiKey` out to use the ChatGPT login from `codex login`
   * (your subscription); set it to bill the OpenAI API.
   */
  codex?: CodexOptions
  /** Build the Codex client yourself (tests, custom binaries). Gets the merged options. */
  createClient?: (options: CodexOptions) => Pick<Codex, "startThread" | "resumeThread">
}

const BRIDGE = "ai_kit"

/**
 * Run ai-kit agents on the OpenAI Codex SDK. Uses Codex's login, so a ChatGPT Plus or Pro
 * subscription works without an API key (subject to OpenAI's terms; use an API key for apps
 * that serve other people).
 *
 * ai-kit tools reach Codex through a local MCP endpoint that lives for one run, bound to
 * 127.0.0.1 and protected with a random bearer token.
 */
export function codex(options: CodexDriverOptions = {}): HarnessDriver {
  return {
    kind: "harness",
    provider: "codex",
    modelId: options.model,
    handles: { compaction: true, contextReadings: false },
    run: (req) => runCodex(req, options),
  }
}

async function* runCodex(req: HarnessRequest, o: CodexDriverOptions): AsyncGenerator<HarnessEvent> {
  const bridge = req.tools.length ? await startBridge(req) : undefined
  const tmp = await mkdtemp(join(tmpdir(), "ai-kit-codex-"))
  try {
    const config = {
      ...o.codex?.config,
      ...(bridge
        ? {
            mcp_servers: {
              ...(o.codex?.config?.mcp_servers as Record<string, unknown> | undefined),
              // ai-kit runs its own permissions and approvals for these, so Codex shouldn't ask again.
              [BRIDGE]: { url: bridge.url, http_headers: { Authorization: `Bearer ${bridge.token}` }, default_tools_approval_mode: "approve" },
            },
          }
        : {}),
      ...(req.system ? { developer_instructions: req.system } : {}),
    }
    const clientOptions: CodexOptions = { ...o.codex, config: config as CodexOptions["config"] }
    const client = o.createClient ? o.createClient(clientOptions) : new (await import("@openai/codex-sdk")).Codex(clientOptions)
    const threadOptions: ThreadOptions = {
      model: o.model,
      sandboxMode: o.sandboxMode ?? "read-only",
      workingDirectory: o.workingDirectory,
      skipGitRepoCheck: o.skipGitRepoCheck ?? !o.workingDirectory,
      networkAccessEnabled: o.networkAccessEnabled,
      webSearchMode: o.webSearch,
      additionalDirectories: o.additionalDirectories,
      approvalPolicy: "never",
      modelReasoningEffort: req.settings.effort,
    }
    // Codex can't fork a thread, so a fork starts fresh with the history as context.
    const resume = req.resumeId && !req.fork
    const thread = resume ? client.resumeThread(req.resumeId!, threadOptions) : client.startThread(threadOptions)
    const history = resume ? [] : req.history
    const input = await toInput(req.input, history, tmp)
    const { events } = await thread.runStreamed(input, { outputSchema: req.output?.schema, signal: req.signal })

    const state = new CodexState()
    for await (const e of events) {
      for (const out of state.map(e)) yield out
      if (state.done) break
    }
    if (!state.done) {
      yield req.signal.aborted
        ? { type: "finish", finishReason: "aborted", usage: state.usage }
        : { type: "finish", finishReason: "stop", usage: state.usage, output: state.output(req) }
    }
  } catch (e) {
    if (req.signal.aborted) yield { type: "finish", finishReason: "aborted", usage: { inputTokens: 0, outputTokens: 0 } }
    else yield { type: "error", error: { message: e instanceof Error ? e.message : String(e) } }
  } finally {
    await bridge?.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function toInput(message: Message, history: Message[], dir: string): Promise<Input> {
  let text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
  if (history.length) {
    const lines = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}`)
    text = `<earlier_conversation>\n${lines.join("\n\n")}\n</earlier_conversation>\n\n${text}`
  }
  const images = message.parts.filter((p) => p.type === "file" && p.mediaType.startsWith("image/"))
  if (!images.length) return text
  const parts: Exclude<Input, string> = [{ type: "text", text }]
  for (const [i, p] of images.entries()) {
    if (p.type !== "file") continue
    const data = p.data ?? (p.url?.startsWith("data:") ? p.url.slice(p.url.indexOf(",") + 1) : undefined)
    if (!data) continue
    const path = join(dir, `image-${i}.${p.mediaType.split("/")[1] ?? "png"}`)
    await writeFile(path, Buffer.from(data, "base64"))
    parts.push({ type: "local_image", path })
  }
  return parts
}

/** A one-run MCP endpoint for Codex on 127.0.0.1. */
async function startBridge(req: HarnessRequest): Promise<{ url: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(24).toString("hex")
  const handler = mcpHttpHandler(() => createMcpServer(req.tools, { name: BRIDGE }), {
    authorize: (r) => r.headers.get("authorization") === `Bearer ${token}`,
  })
  const server: Server = createServer(async (inc, res) => {
    try {
      const response = await handler(await toRequest(inc))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (e) {
      res.writeHead(500).end(String(e))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

async function toRequest(inc: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = []
  for await (const c of inc) chunks.push(c as Buffer)
  const headers = new Headers()
  for (const [k, v] of Object.entries(inc.headers)) if (typeof v === "string") headers.set(k, v)
  const method = inc.method ?? "GET"
  return new Request(`http://127.0.0.1${inc.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  })
}

/** Turns Codex thread events into harness events. Items report full text, so deltas are diffs. */
class CodexState {
  usage: Usage = { inputTokens: 0, outputTokens: 0 }
  done = false
  private step = 0
  private seen = new Map<string, number>()
  private started = new Set<string>()
  private lastMessage = ""

  output(req: HarnessRequest): unknown {
    if (!req.output) return undefined
    try {
      return JSON.parse(this.lastMessage)
    } catch {
      return undefined
    }
  }

  *map(e: ThreadEvent): Generator<HarnessEvent> {
    switch (e.type) {
      case "thread.started":
        yield { type: "harness-session", id: e.thread_id }
        return
      case "turn.started":
        yield { type: "step-start", step: this.step }
        return
      case "item.started":
      case "item.updated":
      case "item.completed":
        yield* this.item(e.item, e.type === "item.completed")
        return
      case "turn.completed":
        this.usage = {
          inputTokens: e.usage.input_tokens,
          outputTokens: e.usage.output_tokens,
          cacheReadTokens: e.usage.cached_input_tokens,
          reasoningTokens: e.usage.reasoning_output_tokens,
        }
        yield { type: "step-finish", step: this.step++, usage: this.usage, finishReason: "stop" }
        return
      case "turn.failed":
        this.done = true
        yield { type: "error", error: { message: e.error.message } }
        return
      case "error":
        this.done = true
        yield { type: "error", error: { message: e.message } }
        return
    }
  }

  private *text(kind: "text" | "reasoning", id: string, full: string, done: boolean): Generator<HarnessEvent> {
    const sent = this.seen.get(id) ?? 0
    if (full.length > sent) {
      const delta = full.slice(sent)
      this.seen.set(id, full.length)
      yield kind === "text" ? { type: "text-delta", partId: id, delta } : { type: "reasoning-delta", partId: id, delta }
    }
    if (done) yield kind === "text" ? { type: "text-end", partId: id } : { type: "reasoning-end", partId: id }
  }

  private *call(id: string, toolName: string, input: unknown): Generator<HarnessEvent> {
    if (this.started.has(id)) return
    this.started.add(id)
    yield { type: "tool-call", toolCallId: id, toolName, input, runtime: "harness" }
  }

  private *item(item: ThreadItem, done: boolean): Generator<HarnessEvent> {
    switch (item.type) {
      case "agent_message":
        if (done) this.lastMessage = item.text
        yield* this.text("text", item.id, item.text, done)
        return
      case "reasoning":
        yield* this.text("reasoning", item.id, item.text, done)
        return
      case "command_execution":
        yield* this.call(item.id, "shell", { command: item.command })
        if (item.status !== "in_progress") {
          yield { type: "tool-result", toolCallId: item.id, output: item.aggregated_output, isError: item.status === "failed" || (item.exit_code ?? 0) !== 0 }
        }
        return
      case "file_change":
        yield* this.call(item.id, "apply_patch", { changes: item.changes })
        if (done) yield { type: "tool-result", toolCallId: item.id, output: item.changes, isError: item.status === "failed" }
        return
      case "mcp_tool_call":
        if (item.server === BRIDGE) return // ai-kit reports bridged calls itself
        yield* this.call(item.id, `mcp__${item.server}__${item.tool}`, item.arguments)
        if (item.status !== "in_progress") {
          yield { type: "tool-result", toolCallId: item.id, output: item.error?.message ?? item.result?.content, isError: item.status === "failed" }
        }
        return
      case "web_search":
        yield* this.call(item.id, "web_search", { query: item.query })
        if (done) yield { type: "tool-result", toolCallId: item.id, output: `Searched: ${item.query}` }
        return
      case "todo_list":
        yield {
          type: "data",
          part: {
            type: "data",
            id: "todos",
            name: "todos",
            data: item.items.map((t) => ({ content: t.text, status: t.completed ? "completed" : "pending" })),
          },
        }
        return
      case "error":
        yield { type: "status", status: "error", detail: item.message }
        return
    }
  }
}
