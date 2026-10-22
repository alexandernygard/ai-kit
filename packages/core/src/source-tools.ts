import { jsonSchema } from "./schema"
import { type Tool, type ToolContext, tool } from "./tools"

/** The files the source tools work on: a document's code, data files, a project. */
export interface SourceFiles {
  /** The file's text, or `undefined` when it doesn't exist. */
  read(path: string): string | undefined | Promise<string | undefined>
  write(path: string, content: string): void | Promise<void>
  /** File names, shown when the model asks for one that doesn't exist. */
  list?(): string[] | Promise<string[]>
}

export interface SourceChange {
  tool: "edit" | "write"
  path: string
  /** `undefined` when the file was created. */
  before: string | undefined
  after: string
  /** The model's few-word label for the change, when it gave one. */
  summary?: string
}

export interface SourceToolsOptions<Ctx = any> {
  /** The files, or a function that picks them per call (per user, per document). */
  files: SourceFiles | ((ctx: ToolContext<Ctx>) => SourceFiles)
  /**
   * Runs after every edit and write. Return a report for the model (compile errors, evaluation
   * results, lint) so it can fix its own mistakes; `undefined` adds nothing.
   */
  feedback?: (change: SourceChange, ctx: ToolContext<Ctx>) => string | undefined | Promise<string | undefined>
  /** For single-document apps: the file used when the model leaves out `path`. */
  defaultPath?: string
  /** Reject a path before it's written, e.g. to allow only `*.csv`. Return the reason. */
  checkPath?: (path: string, tool: "read" | "edit" | "write") => string | undefined
  /** Tool names. Default `read_file`, `edit_file`, `write_file`. */
  names?: { read?: string; edit?: string; write?: string }
}

type ReadInput = { path?: string; offset?: number; limit?: number }
type EditInput = { path?: string; old_string: string; new_string: string; summary?: string }
type WriteInput = { path?: string; content: string; summary?: string }

/**
 * Read, edit and write tools over a set of text files, with an optional feedback hook that tells
 * the model how the result compiles or evaluates.
 *
 * ```ts
 * defineAgent({
 *   tools: sourceTools({
 *     files: { read: () => doc.source, write: (_, text) => doc.setSource(text) },
 *     defaultPath: "workbook.ts",
 *     feedback: async () => report(await evaluate(doc.source)),
 *   }),
 * })
 * ```
 *
 * `edit_file` replaces one exact, unique occurrence, so the model must quote enough context to
 * say which.
 */
export function sourceTools<Ctx = any>(options: SourceToolsOptions<Ctx>): Tool[] {
  const names = { read: "read_file", edit: "edit_file", write: "write_file", ...options.names }
  const pathProp = {
    type: "string",
    description: options.defaultPath ? `File path. Default: ${options.defaultPath}` : "File path",
  }
  const summaryProp = { type: "string", description: 'A few words describing the change, e.g. "Add margin column"' }
  const required = (...keys: string[]) => (options.defaultPath ? keys : ["path", ...keys])
  const filesFor = (ctx: ToolContext<Ctx>) => (typeof options.files === "function" ? options.files(ctx) : options.files)

  const resolve = (path: string | undefined, kind: "read" | "edit" | "write") => {
    const p = path ?? options.defaultPath
    if (!p) throw new Error("path is required.")
    const problem = options.checkPath?.(p, kind)
    if (problem) throw new Error(problem)
    return p
  }
  const missing = async (files: SourceFiles, path: string) => {
    const all = (await files.list?.()) ?? []
    return new Error(`${path} doesn't exist.${all.length ? ` Files: ${all.join(", ")}` : ""}`)
  }
  const commit = async (files: SourceFiles, change: SourceChange, ctx: ToolContext<Ctx>, done: string) => {
    await files.write(change.path, change.after)
    const report = await options.feedback?.(change, ctx)
    return report ? `${done}\n\n${report}` : done
  }

  return [
    tool({
      name: names.read,
      description: "Read a file. Use offset and limit (in lines) for large files.",
      input: jsonSchema<ReadInput>({
        type: "object",
        properties: {
          path: pathProp,
          offset: { type: "integer", description: "First line, 1-based" },
          limit: { type: "integer", description: "Number of lines" },
        },
        required: required(),
      }),
      readOnly: true,
      title: (i) => `Reading ${i.path ?? options.defaultPath ?? "file"}`,
      async execute(input, ctx) {
        const files = filesFor(ctx)
        const path = resolve(input.path, "read")
        const text = await files.read(path)
        if (text === undefined) throw await missing(files, path)
        if (input.offset === undefined && input.limit === undefined) return text
        const lines = text.split("\n")
        const start = Math.max(1, input.offset ?? 1)
        const end = input.limit !== undefined ? start - 1 + input.limit : lines.length
        return `Lines ${start}-${Math.min(end, lines.length)} of ${lines.length}:\n${lines.slice(start - 1, end).join("\n")}`
      },
    }),
    tool({
      name: names.edit,
      description:
        "Replace one exact occurrence of old_string with new_string. old_string must match the file exactly, including whitespace, and appear only once: include enough surrounding lines to make it unique.",
      input: jsonSchema<EditInput>({
        type: "object",
        properties: {
          path: pathProp,
          old_string: { type: "string", description: "The exact text to replace" },
          new_string: { type: "string", description: "The replacement" },
          summary: summaryProp,
        },
        required: required("old_string", "new_string"),
      }),
      title: (i) => i.summary ?? `Editing ${i.path ?? options.defaultPath ?? "file"}`,
      async execute(input, ctx) {
        const files = filesFor(ctx)
        const path = resolve(input.path, "edit")
        const before = await files.read(path)
        if (before === undefined) throw await missing(files, path)
        if (!input.old_string) throw new Error(`old_string is empty. Use ${names.write} to replace the whole file.`)
        if (input.old_string === input.new_string) throw new Error("old_string and new_string are the same.")
        const at = before.indexOf(input.old_string)
        if (at < 0) throw new Error(`old_string wasn't found in ${path}. Read the file to see its current text.`)
        const count = before.split(input.old_string).length - 1
        if (count > 1) throw new Error(`old_string appears ${count} times in ${path}. Include more surrounding text so it matches once.`)
        const after = before.slice(0, at) + input.new_string + before.slice(at + input.old_string.length)
        const line = before.slice(0, at).split("\n").length
        return commit(files, { tool: "edit", path, before, after, summary: input.summary }, ctx, `Edited ${path} at line ${line}.`)
      },
    }),
    tool({
      name: names.write,
      description: "Write a whole file, replacing it or creating it.",
      input: jsonSchema<WriteInput>({
        type: "object",
        properties: { path: pathProp, content: { type: "string", description: "The full file contents" }, summary: summaryProp },
        required: required("content"),
      }),
      destructive: true,
      title: (i) => i.summary ?? `Writing ${i.path ?? options.defaultPath ?? "file"}`,
      async execute(input, ctx) {
        const files = filesFor(ctx)
        const path = resolve(input.path, "write")
        const before = await files.read(path)
        const lines = input.content.split("\n").length
        return commit(files, { tool: "write", path, before, after: input.content, summary: input.summary }, ctx, `${before === undefined ? "Created" : "Wrote"} ${path} (${lines} lines).`)
      },
    }),
  ]
}

/** In-memory `SourceFiles`, for tests and simple apps. `files` is the live map. */
export function memoryFiles(initial: Record<string, string> = {}): SourceFiles & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    read: (path) => files.get(path),
    write: (path, content) => void files.set(path, content),
    list: () => [...files.keys()],
  }
}
