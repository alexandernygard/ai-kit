import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKit, defineAgent, jsonSchema, tool, type ToolContext, type ToolPart } from "@alexandernygard/ai-kit"
import { createHandler } from "@alexandernygard/ai-kit-server"
import { mockModel } from "@alexandernygard/ai-kit/testing"
import { describe, expect, it } from "vitest"
import { fileStore, fileTools, loadSkills, shellTool, toNodeHandler, workerSandbox } from "../src/index"

const tmp = () => mkdtemp(join(tmpdir(), "ai-kit-test-"))
const ctx = { signal: new AbortController().signal, progress: () => {} } as unknown as ToolContext

describe("fileStore", () => {
  it("persists sessions across kits", async () => {
    const dir = await tmp()
    const agents = [defineAgent({ name: "a", model: mockModel([{ text: "remembered" }]) })]
    const s = await createKit({ agents, store: fileStore(dir) }).createSession()
    await s.send("hi").result
    const again = await createKit({ agents, store: fileStore(dir) }).getSession(s.id)
    expect((await again!.history()).length).toBe(2)
  })
})

describe("loadSkills", () => {
  it("reads SKILL.md folders with lazy files", async () => {
    const dir = await tmp()
    await mkdir(join(dir, "refunds/ref"), { recursive: true })
    await writeFile(join(dir, "refunds/SKILL.md"), "---\nname: refunds\ndescription: Handle refunds\n---\nCheck the date.")
    await writeFile(join(dir, "refunds/ref/policy.md"), "30 days")
    await mkdir(join(dir, "not-a-skill"))
    const skills = await loadSkills(dir)
    expect(skills.map((s) => s.name)).toEqual(["refunds"])
    expect(skills[0]!.instructions).toBe("Check the date.")
    expect(await (skills[0]!.files!["ref/policy.md"] as () => Promise<string>)()).toBe("30 days")
  })
})

describe("workerSandbox", () => {
  const sandbox = workerSandbox()
  const env = (tools: Record<string, (i: unknown) => Promise<unknown>> = {}, timeoutMs = 3000) => {
    const logs: string[] = []
    return { logs, env: { tools, console: { log: (t: unknown) => logs.push(String(t)), error: (t: unknown) => logs.push(`E ${t}`) }, signal: new AbortController().signal, timeoutMs } }
  }

  it("runs code that calls host tools", async () => {
    const { env: e, logs } = env({ add: async (i: any) => i.a + i.b })
    const r = await sandbox.execute("const x = await tools.add({ a: 2, b: 3 }); console.log('x is', x); return { x }", e)
    expect(r).toEqual({ result: { x: 5 } })
    expect(logs).toEqual(["x is 5"])
  })

  it("has no access to Node", async () => {
    const { env: e } = env()
    expect((await sandbox.execute("return typeof require + ' ' + typeof process", e)).result).toBe("undefined undefined")
    expect((await sandbox.execute("return eval('1+1')", e)).error).toMatch(/EvalError|Code generation/)
  })

  it("stops runaway code", async () => {
    const { env: e } = env({}, 500)
    expect((await sandbox.execute("while (true) {}", e)).error).toMatch(/timed out/i)
    expect((await sandbox.execute("await new Promise(() => {})", e)).error).toMatch(/Timed out/)
  })

  it("plugs into code mode", async () => {
    const add = tool({
      name: "add",
      description: "Add",
      input: jsonSchema<{ a: number; b: number }>({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }),
      execute: ({ a, b }) => a + b,
    })
    const model = mockModel([{ toolCalls: [{ name: "run_code", input: { code: "return await tools.add({a: 20, b: 22})" } }] }, { text: "42" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [add], codeMode: { sandbox } })] })
    const r = await (await kit.createSession()).send("x").result
    const run = r.message.parts.find((p): p is ToolPart => p.type === "tool" && p.toolName === "run_code")!
    expect(JSON.parse(run.output as string)).toEqual({ result: 42 })
  })
})

describe("fileTools and shellTool", () => {
  it("stays inside the root", async () => {
    const dir = await tmp()
    const kit = fileTools({ root: dir, write: true })
    const byName = Object.fromEntries(kit.tools.map((t) => [t.name, t]))
    await byName.write_file!.execute!({ path: "src/a.ts", content: "const a = 1\nconst b = 2" }, ctx)
    await byName.edit_file!.execute!({ path: "src/a.ts", old_text: "b = 2", new_text: "b = 3" }, ctx)
    expect(await readFile(join(dir, "src/a.ts"), "utf8")).toBe("const a = 1\nconst b = 3")
    expect(await byName.read_file!.execute!({ path: "src/a.ts" }, ctx)).toContain("2\tconst b = 3")
    expect(await byName.list_files!.execute!({}, ctx)).toBe("src/a.ts")
    expect(await byName.search_files!.execute!({ pattern: "b = \\d" }, ctx)).toBe("src/a.ts:2: const b = 3")
    await expect(async () => byName.read_file!.execute!({ path: "../etc/passwd" }, ctx)).rejects.toThrow(/outside/)
  })

  it("runs commands and reports failures", async () => {
    const sh = shellTool({ cwd: await tmp() })
    expect(await sh.execute!({ command: "echo hi" }, ctx)).toBe("hi\n")
    await expect(async () => sh.execute!({ command: "exit 3" }, ctx)).rejects.toThrow(/Exit 3/)
    expect(sh.permissionKey!({ command: "git status" })).toBe("git status")
  })
})

describe("toNodeHandler", () => {
  it("serves the kit over node:http with streaming", async () => {
    const kit = createKit({ agents: [defineAgent({ name: "a", model: mockModel([{ text: "over http" }]) })] })
    const server = createServer(toNodeHandler(createHandler(kit)))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ai`
    const session = await (await fetch(`${base}/sessions`, { method: "POST", body: "{}" })).json()
    const res = await fetch(`${base}/sessions/${session.id}/messages`, { method: "POST", body: JSON.stringify({ content: "hi" }) })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const body = await res.text()
    expect(body).toContain("run-finish")
    expect(body).toContain("over http")
    server.close()
  })
})
