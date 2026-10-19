import type { JSONSchema } from "./schema"
import { jsonSchema } from "./schema"
import { keywordIndex, type ToolIndex } from "./disclosure"
import { type Tool, tool } from "./tools"

/*
 * Code mode. Instead of one model round trip per tool call, the agent writes a short script
 * that calls tools as typed async functions, loops, filters and combines results, and returns
 * only what matters. Large intermediate data never enters the context. This is the pattern
 * behind Cloudflare's Code Mode and Anthropic's code execution with MCP.
 *
 * Every call from the script still goes through permissions, hooks and approvals, and shows up
 * as a nested tool call in the UI.
 */

export interface SandboxEnv {
  /** Tool functions, keyed by identifier. */
  tools: Record<string, (input: unknown) => Promise<unknown>>
  console: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  signal: AbortSignal
  timeoutMs: number
}

export interface SandboxResult {
  result?: unknown
  error?: string
}

/**
 * Runs model-written code. The code is the body of an async function with `tools` and `console`
 * in scope, and may `return` a value.
 */
export interface Sandbox {
  readonly name: string
  execute(code: string, env: SandboxEnv): Promise<SandboxResult>
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>

/**
 * Runs code with `new AsyncFunction` in the current realm. Not isolated: the code can reach
 * globals. Use it for trusted local development only. On a server use the node package's
 * `vmSandbox` (process-isolated) or a remote sandbox such as a Cloudflare Worker Loader.
 */
export function unsafeFunctionSandbox(): Sandbox {
  return {
    name: "function",
    async execute(code, env) {
      const fn = new AsyncFunction("tools", "console", `"use strict";\n${code}`)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          fn(env.tools, env.console),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out after ${env.timeoutMs} ms`)), env.timeoutMs)
            env.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true })
          }),
        ])
        return { result }
      } catch (e) {
        return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ---------------------------------------------------------------------------------------------
// JSON Schema to TypeScript

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export function toIdentifier(name: string): string {
  const id = name.replace(/[^A-Za-z0-9_$]/g, "_")
  return /^[0-9]/.test(id) ? `_${id}` : id
}

function prop(name: string) {
  return IDENT.test(name) ? name : JSON.stringify(name)
}

function doc(text: string | undefined, indent: string): string {
  if (!text) return ""
  const lines = text.trim().split("\n")
  if (lines.length === 1) return `${indent}/** ${lines[0]!.replace(/\*\//g, "*\\/")} */\n`
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l.replace(/\*\//g, "*\\/")}`).join("\n")}\n${indent} */\n`
}

export function jsonSchemaToTs(schema: JSONSchema | undefined, indent = ""): string {
  if (!schema || typeof schema !== "object") return "unknown"
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ")
  const union = schema.anyOf ?? schema.oneOf
  if (union) return union.map((s) => jsonSchemaToTs(s, indent)).join(" | ")
  if (schema.allOf) return schema.allOf.map((s) => jsonSchemaToTs(s, indent)).join(" & ")
  if (Array.isArray(schema.type)) {
    return schema.type.map((t) => jsonSchemaToTs({ ...schema, type: t }, indent)).join(" | ")
  }
  switch (schema.type) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array": {
      const items = Array.isArray(schema.items) ? `[${schema.items.map((s) => jsonSchemaToTs(s, indent)).join(", ")}]` : null
      if (items) return items
      const inner = jsonSchemaToTs(schema.items as JSONSchema | undefined, indent)
      return /[|&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`
    }
    case "object":
    case undefined: {
      if (!schema.properties && schema.type === undefined) return "unknown"
      const required = new Set(schema.required ?? [])
      const inner = indent + "  "
      const props = Object.entries(schema.properties ?? {}).map(
        ([k, v]) => `${doc(v.description, inner)}${inner}${prop(k)}${required.has(k) ? "" : "?"}: ${jsonSchemaToTs(v, inner)}`,
      )
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        props.push(`${inner}[key: string]: ${jsonSchemaToTs(schema.additionalProperties, inner)}`)
      } else if (!props.length) {
        return "Record<string, unknown>"
      }
      return `{\n${props.join("\n")}\n${indent}}`
    }
    default:
      return "unknown"
  }
}

/** A TypeScript declaration of `tools` for the given tools. */
export function toolsDeclaration(tools: Tool[], options: { search?: boolean } = {}): string {
  const members = tools.map((t) => {
    const sig = `${toIdentifier(t.name)}(input: ${jsonSchemaToTs(t.inputSchema, "  ")}): Promise<${t.output ? jsonSchemaToTs(asJson(t.output), "  ") : "any"}>`
    return `${doc(t.description, "  ")}  ${sig}`
  })
  if (options.search) {
    members.push(
      `${doc("Find more tools by what they do. Returns their TypeScript signatures; you can then call them on `tools`.", "  ")}  $search(query: string): Promise<string>`,
    )
  }
  return `declare const tools: {\n${members.join("\n")}\n}`
}

function asJson(s: unknown): JSONSchema | undefined {
  if (s && typeof s === "object" && "jsonSchema" in s) return (s as { jsonSchema: JSONSchema }).jsonSchema
  if (s && typeof s === "object" && "~standard" in s) return undefined
  return s as JSONSchema
}

export interface CodeModeOptions {
  sandbox?: Sandbox
  /** Which tools to offer as functions. Default: every tool with `codeMode !== false`. */
  filter?: (tool: Tool) => boolean
  /** Also keep the tools as normal tool calls. Default false. */
  keepDirectTools?: boolean
  timeoutMs?: number
  /** Cap on the characters returned to the model. Default 20 000. */
  maxOutputChars?: number
  index?: ToolIndex
}

/**
 * The `run_code` tool. `visible` are described in the declaration; `hidden` (deferred) are
 * callable but only discoverable through `tools.$search`.
 */
export function runCodeTool(
  visible: Tool[],
  hidden: Tool[],
  callTool: (name: string, input: unknown, ctx: { toolCallId: string }) => Promise<unknown>,
  options: CodeModeOptions = {},
): Tool {
  const sandbox = options.sandbox ?? unsafeFunctionSandbox()
  const all = [...visible, ...hidden]
  const byIdent = new Map(all.map((t) => [toIdentifier(t.name), t]))
  const declaration = toolsDeclaration(visible, { search: hidden.length > 0 })
  const max = options.maxOutputChars ?? 20_000

  return tool({
    name: "run_code",
    description: [
      "Run JavaScript to do work with the tools below. Write the body of an async function: `await` tool calls, loop, filter, and `return` only what you need. `console.log` output comes back too.",
      "Combine several tool calls into one script instead of calling them one at a time.",
      "",
      "```ts",
      declaration,
      "```",
    ].join("\n"),
    input: jsonSchema<{ code: string }>({
      type: "object",
      properties: { code: { type: "string", description: "JavaScript function body. Use `return` for the result." } },
      required: ["code"],
    }),
    codeMode: false,
    title: () => "Running code",
    async execute({ code }, ctx) {
      const logs: string[] = []
      const fmt = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ")
      const tools: SandboxEnv["tools"] = {}
      for (const [ident, t] of byIdent) {
        tools[ident] = (input) => callTool(t.name, input, { toolCallId: ctx.toolCallId })
      }
      if (hidden.length) {
        tools.$search = async (query) => {
          const index = options.index ?? keywordIndex
          const hits = await index.search(String(query), all.map((t) => ({ tool: t })), 5)
          return hits
            .map((h) => byIdent.get(toIdentifier(h.name)))
            .filter((t): t is Tool => !!t)
            .map((t) => toolsDeclaration([t]).split("\n").slice(1, -1).join("\n"))
            .join("\n")
        }
      }
      const { result, error } = await sandbox.execute(code, {
        tools,
        console: {
          log: (...a) => logs.push(fmt(a)),
          error: (...a) => logs.push(`[error] ${fmt(a)}`),
        },
        signal: ctx.signal,
        timeoutMs: options.timeoutMs ?? 60_000,
      })
      const out: Record<string, unknown> = {}
      if (error) out.error = error
      if (result !== undefined) out.result = result
      if (logs.length) out.logs = logs.join("\n")
      let text = safeJson(out)
      if (text.length > max) text = `${text.slice(0, max)}\n... (truncated ${text.length - max} characters; return less data)`
      if (error) throw new CodeError(text)
      return text
    },
  })
}

class CodeError extends Error {
  override name = "CodeError"
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 1) ?? "undefined"
  } catch {
    return String(v)
  }
}
