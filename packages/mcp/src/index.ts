import {
  type BridgedTool,
  definePlugin,
  jsonSchema,
  type JSONSchema,
  type Plugin,
  type Tool,
  type ToolContext,
  type Toolkit,
  tool,
  toolkit,
  toModelOutput,
  toToolSpec,
  type ToolResultContent,
} from "@alexandernygard/ai-kit"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"

// ---------------------------------------------------------------------------------------------
// MCP servers as toolkits

export type McpTransportConfig =
  /** Streamable HTTP. Works in the browser, on Workers and in Node. */
  | { url: string; headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>) }
  /** A local process over stdio. Node only. */
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  /** Any MCP transport you construct yourself. */
  | { transport: Transport }

export interface McpServerConfig {
  /** Short name, used in tool names: `mcp__<name>__<tool>`. */
  name: string
  description?: string
  transport: McpTransportConfig
  /** Hide the tools until tool search loads them. Default true: MCP servers can have many tools. */
  defer?: boolean
  /** Only these tools. */
  include?: string[]
  exclude?: string[]
  /** Tool name prefix. Default `mcp__<name>__`; `false` keeps the server's names. */
  prefix?: string | false
  /** Ask before every call from this server. Default: ask for tools not marked read-only. */
  needsApproval?: boolean | "unless-read-only"
  /** Extra system prompt text when the toolkit is loaded. Defaults to the server's instructions. */
  instructions?: string
  timeoutMs?: number
}

export interface McpConnection {
  toolkit: Toolkit
  client: Client
  close(): Promise<void>
}

async function openTransport(cfg: McpTransportConfig): Promise<Transport> {
  if ("transport" in cfg) return cfg.transport
  if ("url" in cfg) {
    const headers = typeof cfg.headers === "function" ? await cfg.headers() : cfg.headers
    return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } })
  }
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
  return new StdioClientTransport({ command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd })
}

/** Connect to an MCP server and turn its tools into an ai-kit toolkit. */
export async function connectMcp(config: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: "ai-kit", version: "0.1.0" })
  await client.connect(await openTransport(config.transport))
  const listed: Array<{ name: string; description?: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string } }> = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    listed.push(...(page.tools as typeof listed))
    cursor = page.nextCursor
  } while (cursor)

  const prefix = config.prefix === false ? "" : (config.prefix ?? `mcp__${config.name}__`)
  const tools = listed
    .filter((t) => (!config.include || config.include.includes(t.name)) && !config.exclude?.includes(t.name))
    .map((t) => {
      const readOnly = t.annotations?.readOnlyHint === true
      const approval = config.needsApproval ?? "unless-read-only"
      return tool({
        name: sanitize(`${prefix}${t.name}`),
        description: t.description ?? t.annotations?.title ?? t.name,
        input: jsonSchema(t.inputSchema as JSONSchema),
        readOnly,
        destructive: t.annotations?.destructiveHint,
        needsApproval: approval === "unless-read-only" ? !readOnly : approval,
        keywords: [config.name],
        timeoutMs: config.timeoutMs,
        title: () => t.annotations?.title ?? t.name,
        toModelOutput: (out: unknown) => (isToolResultContent(out) ? out : toModelOutput(undefined, out)),
        execute: async (input, ctx) => {
          const res = (await client.callTool({ name: t.name, arguments: input as Record<string, unknown> }, undefined, { signal: ctx.signal })) as CallToolResult
          const content = fromMcpContent(res)
          if (res.isError) throw new Error(content.type === "text" ? content.value : JSON.stringify(content.value))
          return content
        },
      })
    })

  return {
    client,
    toolkit: toolkit({
      name: config.name,
      description: config.description ?? client.getInstructions()?.split("\n")[0] ?? `Tools from the ${config.name} MCP server`,
      instructions: config.instructions ?? client.getInstructions(),
      tools,
      defer: config.defer ?? true,
    }),
    close: () => client.close(),
  }
}

/** A plugin that connects to MCP servers when the kit starts. */
export function mcpPlugin(servers: McpServerConfig[], options: { name?: string } = {}): Plugin & { close(): Promise<void> } {
  const connections: McpConnection[] = []
  const plugin = definePlugin({
    name: options.name ?? "mcp",
    async setup(api) {
      const results = await Promise.allSettled(servers.map((s) => connectMcp(s)))
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          connections.push(r.value)
          api.addTools(r.value.toolkit)
        } else {
          console.warn(`[ai-kit] MCP server ${servers[i]!.name} failed to connect:`, r.reason)
        }
      })
    },
  })
  return { ...plugin, close: async () => void (await Promise.all(connections.map((c) => c.close()))) }
}

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

function isToolResultContent(x: unknown): x is ToolResultContent {
  return typeof x === "object" && x !== null && "type" in x && "value" in x && ["text", "json", "content"].includes((x as { type: string }).type)
}

function fromMcpContent(res: CallToolResult): ToolResultContent {
  if (res.structuredContent !== undefined && !res.content?.length) return { type: "json", value: res.structuredContent }
  const blocks = (res.content ?? []).flatMap((c): Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; data: string }> => {
    if (c.type === "text") return [{ type: "text", text: c.text }]
    if (c.type === "image") return [{ type: "image", mediaType: c.mimeType, data: c.data }]
    if (c.type === "resource" && "text" in c.resource) return [{ type: "text", text: String(c.resource.text) }]
    if (c.type === "resource_link") return [{ type: "text", text: `${c.name}: ${c.uri}` }]
    return [{ type: "text", text: JSON.stringify(c) }]
  })
  if (blocks.every((b) => b.type === "text")) return { type: "text", value: blocks.map((b) => (b as { text: string }).text).join("\n") }
  return { type: "content", value: blocks }
}

// ---------------------------------------------------------------------------------------------
// ai-kit tools as an MCP server

/** What `createMcpServer` serves: bridged tools from a harness run, or plain tools. */
export type ServedTool = BridgedTool | Tool

export interface CreateMcpServerOptions {
  name?: string
  version?: string
  instructions?: string
  /** For plain tools: the context their `execute` gets. */
  toolContext?: (call: { toolName: string; toolCallId: string; signal: AbortSignal }) => Partial<ToolContext>
}

/**
 * An MCP server for ai-kit tools, with JSON Schemas passed through as-is. Harness drivers use
 * it to give the Claude Agent SDK and Codex your tools; you can also serve it to Claude Desktop
 * or any MCP client with `mcpHttpHandler`.
 */
export function createMcpServer(tools: ServedTool[], options: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: options.name ?? "ai-kit", version: options.version ?? "0.1.0" },
    { capabilities: { tools: {} }, instructions: options.instructions },
  )
  const entries = tools.map((t) => ("spec" in t ? t : plainToBridged(t, options.toolContext)))
  const byName = new Map(entries.map((e) => [e.spec.name, e]))
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: entries.map((e) => ({ name: e.spec.name, description: e.spec.description, inputSchema: { type: "object", ...e.spec.inputSchema } as never })),
  }))
  server.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const entry = byName.get(req.params.name)
    if (!entry) return { content: [{ type: "text", text: `Unknown tool ${req.params.name}` }], isError: true }
    const toolCallId = String((req.params._meta as { toolUseId?: string } | undefined)?.toolUseId ?? extra.requestId)
    const { output, isError } = await entry.execute(req.params.arguments ?? {}, { toolCallId, signal: extra.signal })
    return toMcpResult(output, isError)
  })
  return server
}

function plainToBridged(t: Tool, ctx: CreateMcpServerOptions["toolContext"]): BridgedTool {
  return {
    spec: toToolSpec(t),
    async execute(input, call) {
      if (!t.execute) return { output: { type: "text", value: `${t.name} runs in the client` }, isError: true }
      try {
        const base: ToolContext = {
          toolCallId: call.toolCallId,
          toolName: t.name,
          sessionId: "mcp",
          runId: "mcp",
          agent: "mcp",
          signal: call.signal,
          context: undefined,
          state: { get: () => undefined, set: () => {}, delete: () => {} },
          messages: () => [],
          progress: () => {},
          emit: () => {},
          callTool: async () => {
            throw new Error("callTool isn't available over MCP")
          },
          ...ctx?.({ toolName: t.name, toolCallId: call.toolCallId, signal: call.signal }),
        }
        const out = await t.execute(input, base)
        return { output: toModelOutput(t, out), isError: false }
      } catch (e) {
        return { output: { type: "text", value: e instanceof Error ? e.message : String(e) }, isError: true }
      }
    },
  }
}

export function toMcpResult(output: ToolResultContent, isError = false): CallToolResult {
  if (output.type === "text") return { content: [{ type: "text", text: output.value }], isError }
  if (output.type === "json") return { content: [{ type: "text", text: JSON.stringify(output.value) }], isError }
  return {
    content: output.value.map((v) => (v.type === "text" ? { type: "text" as const, text: v.text } : { type: "image" as const, data: v.data, mimeType: v.mediaType })),
    isError,
  }
}

/**
 * A fetch-style handler serving an MCP server over streamable HTTP, statelessly: a fresh
 * server per request. Mount it on any route (`/mcp`) in Hono, Next, SvelteKit or Workers.
 */
export function mcpHttpHandler(makeServer: () => McpServer | Promise<McpServer>, options: { authorize?: (req: Request) => boolean | Promise<boolean> } = {}) {
  return async (req: Request): Promise<Response> => {
    if (options.authorize && !(await options.authorize(req))) return new Response("Unauthorized", { status: 401 })
    const server = await makeServer()
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(req)
    } finally {
      void transport.close()
      void server.close()
    }
  }
}
