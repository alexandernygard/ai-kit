import { jsonSchema, type JSONSchema } from "./schema"
import type { KV } from "./store/kv"
import { type Tool, tool } from "./tools"

export interface AskUserQuestion {
  question: string
  /** Short label for compact UIs. */
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

export interface AskUserAnswer {
  answers: Record<string, string | string[]>
}

/**
 * `ask_user`: the agent asks the person one to four multiple-choice questions. It's a client
 * tool, so the run pauses until the UI sends the answers (a questionnaire component fits).
 */
export function askUserTool(): Tool<{ questions: AskUserQuestion[] }, AskUserAnswer> {
  return tool({
    name: "ask_user",
    description:
      "Ask the user questions when you need a decision or missing information to continue. Offer 2-4 options per question when you can; the user can always answer in their own words.",
    input: jsonSchema<{ questions: AskUserQuestion[] }>({
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              header: { type: "string", description: "A label of at most 12 characters" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: { label: { type: "string" }, description: { type: "string" } },
                  required: ["label"],
                },
              },
              multiSelect: { type: "boolean" },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    }),
    runtime: "client",
    readOnly: true,
    codeMode: false,
    title: (i) => i.questions[0]?.question ?? "Question",
  })
}

export interface Todo {
  content: string
  status: "pending" | "in_progress" | "completed"
  /** Present tense, shown while in progress: "Running tests". */
  activeForm?: string
}

export const TODOS_KEY = "ai-kit.todos"

/**
 * `todo_write`: a task list the agent keeps up to date, like Claude Code's. Stored in session
 * state and emitted as a `todos` data part so UIs can show a live checklist.
 */
export function todoTool(): Tool<{ todos: Todo[] }> {
  return tool({
    name: "todo_write",
    description:
      "Create and update a task list for multi-step work. Send the whole list every time. Keep exactly one task in_progress while working, and mark tasks completed as soon as they are done.",
    input: jsonSchema<{ todos: Todo[] }>({
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              activeForm: { type: "string" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    }),
    readOnly: true,
    codeMode: false,
    title: () => "Updating tasks",
    execute({ todos }, ctx) {
      ctx.state.set(TODOS_KEY, todos)
      ctx.emit({ id: "todos", name: "todos", data: todos })
      const done = todos.filter((t) => t.status === "completed").length
      return `Saved ${todos.length} tasks (${done} done).`
    },
  })
}

type MemoryCommand =
  | { command: "view"; path?: string }
  | { command: "create"; path: string; file_text: string }
  | { command: "str_replace"; path: string; old_str: string; new_str: string }
  | { command: "insert"; path: string; insert_line: number; insert_text: string }
  | { command: "delete"; path: string }
  | { command: "rename"; old_path: string; new_path: string }

/**
 * `memory`: long-term notes the agent keeps across sessions, as files under /memories. Same
 * commands as Anthropic's memory tool, stored in any KV. Scope it per user with `namespace`.
 */
export function memoryTool<Ctx = any>(kv: KV, options: { namespace?: (ctx: Ctx) => string } = {}): Tool<MemoryCommand, string, Ctx> {
  const norm = (p: string | undefined) => {
    const path = (p ?? "/memories").replace(/\/+$/, "") || "/memories"
    if (!path.startsWith("/memories") || path.includes("..")) throw new Error("Paths must be inside /memories")
    return path
  }
  return tool({
    name: "memory",
    description:
      "Your memory directory (/memories) persists between conversations. View it at the start of a task, and record progress and facts worth keeping as you go. Commands: view, create, str_replace, insert, delete, rename.",
    input: jsonSchema<MemoryCommand>({
      type: "object",
      properties: {
        command: { type: "string", enum: ["view", "create", "str_replace", "insert", "delete", "rename"] },
        path: { type: "string" },
        file_text: { type: "string" },
        old_str: { type: "string" },
        new_str: { type: "string" },
        insert_line: { type: "integer" },
        insert_text: { type: "string" },
        old_path: { type: "string" },
        new_path: { type: "string" },
      },
      required: ["command"],
    }),
    title: (i) => `Memory: ${i.command} ${"path" in i ? (i.path ?? "") : ""}`.trim(),
    async execute(cmd, ctx) {
      const ns = options.namespace?.(ctx.context) ?? "default"
      const key = (p: string) => `memory:${ns}:${p}`
      switch (cmd.command) {
        case "view": {
          const path = norm(cmd.path)
          const file = await kv.get(key(path))
          if (file != null) {
            return file
              .split("\n")
              .map((l, i) => `${String(i + 1).padStart(4)}\t${l}`)
              .join("\n")
          }
          const files = (await kv.list(key(path + "/"))).map((k) => k.slice(key("").length))
          return files.length ? `Files in ${path}:\n${files.join("\n")}` : `${path} is empty.`
        }
        case "create":
          await kv.set(key(norm(cmd.path)), cmd.file_text)
          return `Created ${cmd.path}`
        case "str_replace": {
          const path = norm(cmd.path)
          const file = await kv.get(key(path))
          if (file == null) throw new Error(`${path} does not exist`)
          const count = file.split(cmd.old_str).length - 1
          if (count !== 1) throw new Error(count ? `old_str appears ${count} times; make it unique` : "old_str not found")
          await kv.set(key(path), file.replace(cmd.old_str, cmd.new_str))
          return `Edited ${path}`
        }
        case "insert": {
          const path = norm(cmd.path)
          const lines = ((await kv.get(key(path))) ?? "").split("\n")
          lines.splice(cmd.insert_line, 0, cmd.insert_text)
          await kv.set(key(path), lines.join("\n"))
          return `Inserted into ${path}`
        }
        case "delete": {
          const path = norm(cmd.path)
          await kv.delete(key(path))
          for (const k of await kv.list(key(path + "/"))) await kv.delete(k)
          return `Deleted ${path}`
        }
        case "rename": {
          const from = norm(cmd.old_path)
          const to = norm(cmd.new_path)
          const file = await kv.get(key(from))
          if (file == null) throw new Error(`${from} does not exist`)
          await kv.set(key(to), file)
          await kv.delete(key(from))
          return `Renamed ${from} to ${to}`
        }
      }
    },
  })
}

export const STRUCTURED_OUTPUT_TOOL = "structured_output"

/** The tool used for structured output on models without native JSON-schema output. */
export function structuredOutputTool(schema: JSONSchema): Tool {
  return tool({
    name: STRUCTURED_OUTPUT_TOOL,
    description: "Give your final answer by calling this tool once with data that matches the schema. Call it last.",
    input: jsonSchema(schema),
    readOnly: true,
    codeMode: false,
    execute: () => "Recorded.",
  })
}
