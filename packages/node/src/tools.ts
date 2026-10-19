import { spawn } from "node:child_process"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { jsonSchema, type Tool, type Toolkit, tool, toolkit } from "@alexandernygard/ai-kit"

export interface FileToolsOptions {
  /** Every path is resolved inside this folder; anything outside is refused. */
  root: string
  /** Include write and edit tools. Default false. */
  write?: boolean
  /** Ask before writes. Default true. */
  approveWrites?: boolean
  maxReadBytes?: number
}

/** read_file, list_files, search_files, and with `write` also write_file and edit_file, confined to `root`. */
export function fileTools(options: FileToolsOptions): Toolkit {
  const root = resolve(options.root)
  const inside = (p: string) => {
    const abs = resolve(root, p)
    const rel = relative(root, abs)
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${p} is outside the allowed folder`)
    return abs
  }
  const show = (abs: string) => relative(root, abs).split(sep).join("/") || "."
  const approve = options.approveWrites ?? true

  const tools: Tool[] = [
    tool({
      name: "read_file",
      description: "Read a text file. Returns numbered lines. Use offset and limit for big files.",
      input: jsonSchema<{ path: string; offset?: number; limit?: number }>({
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer", description: "First line, from 1" }, limit: { type: "integer" } },
        required: ["path"],
      }),
      readOnly: true,
      title: (i) => `Reading ${i.path}`,
      async execute({ path, offset = 1, limit = 2000 }) {
        const abs = inside(path)
        const size = (await stat(abs)).size
        if (size > (options.maxReadBytes ?? 2_000_000)) throw new Error(`${path} is ${size} bytes; read a range instead`)
        const lines = (await readFile(abs, "utf8")).split("\n")
        return lines
          .slice(offset - 1, offset - 1 + limit)
          .map((l, i) => `${String(offset + i).padStart(5)}\t${l}`)
          .join("\n")
      },
    }),
    tool({
      name: "list_files",
      description: "List files under a folder, recursively, skipping dot-folders and node_modules.",
      input: jsonSchema<{ path?: string; maxEntries?: number }>({ type: "object", properties: { path: { type: "string" }, maxEntries: { type: "integer" } } }),
      readOnly: true,
      title: (i) => `Listing ${i.path ?? "."}`,
      async execute({ path = ".", maxEntries = 500 }) {
        const out: string[] = []
        const walk = async (dir: string) => {
          for (const e of await readdir(dir, { withFileTypes: true })) {
            if (out.length >= maxEntries) return
            if (e.name.startsWith(".") || e.name === "node_modules") continue
            const p = join(dir, e.name)
            if (e.isDirectory()) await walk(p)
            else out.push(show(p))
          }
        }
        await walk(inside(path))
        return out.length >= maxEntries ? `${out.join("\n")}\n(stopped at ${maxEntries})` : out.join("\n")
      },
    }),
    tool({
      name: "search_files",
      description: "Search file contents with a regular expression. Returns path:line: text.",
      input: jsonSchema<{ pattern: string; path?: string; maxResults?: number }>({
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" }, maxResults: { type: "integer" } },
        required: ["pattern"],
      }),
      readOnly: true,
      title: (i) => `Searching for ${i.pattern}`,
      async execute({ pattern, path = ".", maxResults = 100 }) {
        const re = new RegExp(pattern)
        const hits: string[] = []
        const walk = async (dir: string) => {
          for (const e of await readdir(dir, { withFileTypes: true })) {
            if (hits.length >= maxResults) return
            if (e.name.startsWith(".") || e.name === "node_modules") continue
            const p = join(dir, e.name)
            if (e.isDirectory()) await walk(p)
            else if ((await stat(p)).size < 1_000_000) {
              const lines = (await readFile(p, "utf8")).split("\n")
              lines.forEach((l, i) => {
                if (hits.length < maxResults && re.test(l)) hits.push(`${show(p)}:${i + 1}: ${l.trim().slice(0, 200)}`)
              })
            }
          }
        }
        await walk(inside(path))
        return hits.join("\n") || "No matches."
      },
    }),
  ]
  if (options.write) {
    tools.push(
      tool({
        name: "write_file",
        description: "Create or overwrite a file.",
        input: jsonSchema<{ path: string; content: string }>({ type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }),
        needsApproval: approve,
        destructive: true,
        title: (i) => `Writing ${i.path}`,
        async execute({ path, content }) {
          const abs = inside(path)
          await mkdir(dirname(abs), { recursive: true })
          await writeFile(abs, content)
          return `Wrote ${show(abs)} (${content.length} characters)`
        },
      }),
      tool({
        name: "edit_file",
        description: "Replace one exact occurrence of old_text with new_text in a file. old_text must be unique; include surrounding lines if needed.",
        input: jsonSchema<{ path: string; old_text: string; new_text: string }>({
          type: "object",
          properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
          required: ["path", "old_text", "new_text"],
        }),
        needsApproval: approve,
        title: (i) => `Editing ${i.path}`,
        async execute({ path, old_text, new_text }) {
          const abs = inside(path)
          const text = await readFile(abs, "utf8")
          const count = text.split(old_text).length - 1
          if (count !== 1) throw new Error(count ? `old_text appears ${count} times` : "old_text not found")
          await writeFile(abs, text.replace(old_text, () => new_text))
          return `Edited ${show(abs)}`
        },
      }),
    )
  }
  return toolkit({ name: "files", description: `Read${options.write ? " and edit" : ""} files in ${root}`, tools })
}

export interface ShellToolOptions {
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
  /** Cap on output returned to the model. Default 30 000 characters. */
  maxOutput?: number
}

/**
 * `bash`: run a shell command in `cwd`. Asks before every command unless a permission rule
 * allows it, e.g. `allow: ["bash(git status*)", "bash(npm test*)"]`.
 */
export function shellTool(options: ShellToolOptions): Tool<{ command: string }> {
  return tool({
    name: "bash",
    description: `Run a shell command in ${options.cwd}. Output is stdout and stderr together.`,
    input: jsonSchema<{ command: string }>({ type: "object", properties: { command: { type: "string" } }, required: ["command"] }),
    needsApproval: true,
    permissionKey: (i) => i.command,
    title: (i) => i.command.slice(0, 80),
    execute: ({ command }, ctx) =>
      new Promise<string>((done, fail) => {
        const child = spawn("bash", ["-lc", command], { cwd: options.cwd, env: { ...process.env, ...options.env }, signal: ctx.signal })
        let out = ""
        const max = options.maxOutput ?? 30_000
        const add = (d: Buffer) => {
          out += d.toString()
          if (out.length > max * 2) out = out.slice(-max * 2)
          ctx.progress({ bytes: out.length })
        }
        child.stdout.on("data", add)
        child.stderr.on("data", add)
        const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000)
        child.on("error", (e) => (clearTimeout(timer), fail(e)))
        child.on("close", (code) => {
          clearTimeout(timer)
          const text = out.length > max ? `...(${out.length - max} characters cut)\n${out.slice(-max)}` : out
          if (code === 0) done(text || "(no output)")
          else fail(new Error(`Exit ${code}\n${text}`))
        })
      }),
  })
}
