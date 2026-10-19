import type { ToolResultContent, ToolSpec } from "./driver"
import type { DataPart, Message } from "./messages"
import { type InferSchema, type JSONSchema, type Schema, toJsonSchema } from "./schema"

/** What a tool can reach while it runs. */
export interface ToolContext<Ctx = any> {
  toolCallId: string
  toolName: string
  sessionId: string
  runId: string
  agent: string
  signal: AbortSignal
  /** App context passed to `send(..., { context })`: the user, a db handle, etc. */
  context: Ctx
  /** Session-scoped state that persists across runs. */
  state: StateAccess
  /** The conversation up to this call. */
  messages: () => Message[]
  /** Report progress. UIs show it on the tool call. */
  progress: (data: unknown) => void
  /** Add a data part to the assistant message (or send it transiently). */
  emit: (part: Omit<DataPart, "type" | "id"> & { id?: string }, options?: { transient?: boolean }) => void
  /** Call another tool through the permission and hook pipeline. */
  callTool: (name: string, input: unknown) => Promise<unknown>
}

export interface StateAccess {
  get<T = unknown>(key: string): T | undefined
  set(key: string, value: unknown): void
  delete(key: string): void
}

export type ToolExecute<I, O, Ctx> = (
  input: I,
  ctx: ToolContext<Ctx>,
) => O | Promise<O> | AsyncIterable<unknown>

export interface ToolDefinition<I = any, O = any, Ctx = any> {
  name: string
  description: string
  input?: Schema<I> | JSONSchema
  output?: Schema<O> | JSONSchema
  /** Leave out for client tools: the browser runs them and sends back the output. */
  execute?: ToolExecute<I, O, Ctx>
  /** Defaults to `server` when there's an `execute`, `client` otherwise. */
  runtime?: "server" | "client"
  /** Ask before running. A function decides per call. */
  needsApproval?: boolean | ((input: I, ctx: ToolContext<Ctx>) => boolean | Promise<boolean>)
  /** No side effects. Plan and read-only modes allow only these. */
  readOnly?: boolean
  /** Deletes or overwrites things. Shown to approvers. */
  destructive?: boolean
  /**
   * Keep out of the model's tool list until found with tool search. Use for large or rarely
   * needed tool sets so they don't fill the context.
   */
  defer?: boolean
  /** Words that help tool search find this tool. */
  keywords?: string[]
  /** Offer this tool inside code mode. Default true. */
  codeMode?: boolean
  /** Rule key for permissions, e.g. `git push` so a rule `bash(git *)` can match. */
  permissionKey?: (input: I) => string
  /** Short label for UIs, e.g. `Searching "flights to Oslo"`. */
  title?: (input: I) => string
  timeoutMs?: number
  /** How the output is shown to the model. Default: strings as text, the rest as JSON. */
  toModelOutput?: (output: O) => ToolResultContent | string
  /** Run on its own rather than alongside other calls in the same step. */
  sequential?: boolean
  /** Example inputs, shown in code mode and tool search. */
  examples?: Array<{ input: I; description?: string }>
  /** Provider-defined tool (web search, code execution). The provider runs it. */
  provider?: Record<string, unknown>
}

export interface Tool<I = any, O = any, Ctx = any> extends ToolDefinition<I, O, Ctx> {
  readonly kind: "tool"
  readonly runtime: "server" | "client"
  /** JSON Schema for the input, computed once. */
  readonly inputSchema: JSONSchema
}

/**
 * Define a tool. `input` takes a zod (or any Standard Schema) schema, or a JSON Schema.
 *
 * ```ts
 * const getWeather = tool({
 *   name: "get_weather",
 *   description: "Current weather for a city",
 *   input: z.object({ city: z.string() }),
 *   readOnly: true,
 *   execute: async ({ city }) => fetchWeather(city),
 * })
 * ```
 */
export function tool<S extends Schema<any> | JSONSchema, O = unknown, Ctx = any>(
  def: Omit<ToolDefinition<InferInput<S>, O, Ctx>, "input"> & { input?: S },
): Tool<InferInput<S>, O, Ctx> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) {
    throw new Error(`Tool name "${def.name}" must be 1-64 letters, digits, _ or -.`)
  }
  let inputSchema: JSONSchema | undefined
  return {
    ...(def as ToolDefinition<InferInput<S>, O, Ctx>),
    kind: "tool",
    runtime: def.runtime ?? (def.execute || def.provider ? "server" : "client"),
    get inputSchema() {
      inputSchema ??= toJsonSchema(def.input as Schema)
      return inputSchema
    },
  }
}

type InferInput<S> = S extends Schema<any> ? InferSchema<S> : any

export function isTool(x: unknown): x is Tool {
  return typeof x === "object" && x !== null && (x as Tool).kind === "tool"
}

/**
 * A named group of tools. Deferred toolkits show only their name and description until the
 * agent loads them, which keeps big tool sets (an MCP server with 80 tools) out of the context.
 */
export interface Toolkit {
  readonly kind: "toolkit"
  name: string
  description: string
  /** Extra instructions added to the system prompt once the toolkit is loaded. */
  instructions?: string
  tools: Tool[]
  /** Hide the tools until loaded. Default false. */
  defer?: boolean
}

export function toolkit(def: Omit<Toolkit, "kind">): Toolkit {
  return { ...def, kind: "toolkit" }
}

export function isToolkit(x: unknown): x is Toolkit {
  return typeof x === "object" && x !== null && (x as Toolkit).kind === "toolkit"
}

export type ToolInput = Tool | Toolkit | Array<Tool | Toolkit> | Record<string, Tool>

/** Flatten tools, toolkits, arrays and records into tools and toolkits. */
export function collectTools(input: ToolInput | undefined): { tools: Tool[]; toolkits: Toolkit[] } {
  const tools: Tool[] = []
  const toolkits: Toolkit[] = []
  const visit = (x: unknown) => {
    if (!x) return
    if (Array.isArray(x)) x.forEach(visit)
    else if (isTool(x)) tools.push(x)
    else if (isToolkit(x)) toolkits.push(x)
    else if (typeof x === "object") Object.values(x).forEach(visit)
  }
  visit(input)
  return { tools, toolkits }
}

export function toToolSpec(t: Tool): ToolSpec {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema, provider: t.provider }
}

export function toModelOutput(t: Tool | undefined, output: unknown): ToolResultContent {
  if (t?.toModelOutput) {
    const r = t.toModelOutput(output)
    return typeof r === "string" ? { type: "text", value: r } : r
  }
  if (typeof output === "string") return { type: "text", value: output }
  if (output === undefined) return { type: "text", value: "Done." }
  return { type: "json", value: output }
}

export function errorOutput(message: string): ToolResultContent {
  return { type: "text", value: message }
}
