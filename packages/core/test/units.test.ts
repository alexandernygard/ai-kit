import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import {
  checkPermission,
  decodeSSE,
  EventHub,
  jsonSchemaToTs,
  keywordIndex,
  memoryKV,
  memoryTool,
  parseSkillMarkdown,
  reduceMessage,
  ruleMatches,
  skillFromMarkdown,
  sqlStore,
  sseResponse,
  toJsonSchema,
  tool,
  toModelTurns,
  validate,
  type Message,
  type ToolContext,
} from "../src/index"
import { z } from "zod"

const msg = (over: Partial<Message> = {}): Message => ({ id: "m", role: "assistant", parts: [], parentId: null, createdAt: 0, ...over })

describe("schemas", () => {
  it("reads zod and validates", async () => {
    const s = z.object({ city: z.string().describe("City name"), days: z.number().optional() })
    expect(toJsonSchema(s)).toMatchObject({ type: "object", properties: { city: { type: "string", description: "City name" } }, required: ["city"] })
    expect(toJsonSchema(s).$schema).toBeUndefined()
    expect(await validate(s, { city: "Oslo" })).toEqual({ success: true, value: { city: "Oslo" } })
    const bad = await validate(s, { city: 1 })
    expect(bad.success).toBe(false)
    expect(!bad.success && bad.error).toContain("city")
  })

  it("infers tool input types from zod", () => {
    const t = tool({ name: "x", description: "x", input: z.object({ n: z.number() }), execute: ({ n }) => n * 2 })
    expect(t.inputSchema.properties?.n).toEqual({ type: "number" })
    expect(t.runtime).toBe("server")
  })
})

describe("reducer", () => {
  it("builds a message from events", () => {
    let m = msg()
    m = reduceMessage(m, { type: "step-start", step: 0 })
    m = reduceMessage(m, { type: "text-delta", partId: "t", delta: "Hel" })
    m = reduceMessage(m, { type: "text-delta", partId: "t", delta: "lo" })
    m = reduceMessage(m, { type: "tool-input-start", toolCallId: "c", toolName: "x", runtime: "server" })
    m = reduceMessage(m, { type: "tool-input-delta", toolCallId: "c", delta: '{"a":' })
    expect(m.parts.at(-1)).toMatchObject({ state: "input-streaming", inputText: '{"a":' })
    m = reduceMessage(m, { type: "tool-call", toolCallId: "c", toolName: "x", input: { a: 1 }, runtime: "server" })
    m = reduceMessage(m, { type: "tool-start", toolCallId: "c" })
    m = reduceMessage(m, { type: "tool-progress", toolCallId: "c", data: 50 })
    m = reduceMessage(m, { type: "tool-result", toolCallId: "c", output: "ok" })
    expect(m.parts).toMatchObject([
      { type: "step", index: 0 },
      { type: "text", text: "Hello" },
      { type: "tool", state: "output-available", output: "ok", progress: [50] },
    ])
  })

  it("nests subagent messages only when asked", () => {
    let m = reduceMessage(msg(), { type: "tool-call", toolCallId: "c", toolName: "task", input: {}, runtime: "server" })
    const ev = { type: "subagent" as const, toolCallId: "c", sessionId: "s2", event: { type: "text-delta" as const, partId: "t", delta: "hi" } }
    expect(reduceMessage(m, ev)).toBe(m)
    m = reduceMessage(m, ev, { nestSubagents: true })
    expect((m.parts[0] as any).child.parts[0].text).toBe("hi")
  })
})

describe("model turns", () => {
  it("splits steps and closes interrupted calls", () => {
    const turns = toModelTurns([
      msg({ id: "u", role: "user", parts: [{ type: "text", id: "1", text: "hi" }] }),
      msg({
        id: "a",
        status: "aborted",
        parts: [
          { type: "step", index: 0 },
          { type: "text", id: "2", text: "Let me look." },
          { type: "tool", toolCallId: "c1", toolName: "x", state: "output-available", runtime: "server", input: {}, output: "found" },
          { type: "tool", toolCallId: "c2", toolName: "x", state: "running", runtime: "server", input: {} },
          { type: "step", index: 1 },
          { type: "text", id: "3", text: "Done." },
        ],
      }),
    ])
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(JSON.stringify(turns[2])).toContain("Interrupted")
  })

  it("clears large old tool results", () => {
    const big = "x".repeat(5000)
    const mk = (id: string) =>
      msg({ id, parts: [{ type: "tool", toolCallId: id, toolName: "t", state: "output-available", runtime: "server", input: {}, output: big }] })
    const turns = toModelTurns([mk("a1"), mk("a2"), mk("a3"), mk("a4")])
    const results = turns.filter((t) => t.role === "tool").map((t) => JSON.stringify(t))
    expect(results[0]).toContain("Output removed")
    expect(results[3]).toContain("xxxx")
  })
})

describe("permissions", () => {
  it("matches globs and keys", () => {
    expect(ruleMatches("mcp__github__*", "mcp__github__create_issue", {})).toBe(true)
    expect(ruleMatches("bash(git *)", "bash", "git push")).toBe(true)
    expect(ruleMatches("bash(git *)", "bash", "rm -rf")).toBe(false)
    expect(ruleMatches({ tool: "pay", when: (i) => i.amount < 100 }, "pay", { amount: 50 })).toBe(true)
  })

  it("orders deny, allow, mode and needsApproval", async () => {
    const t = tool({ name: "send_email", description: "", needsApproval: true, execute: () => "" })
    const ctx = {} as ToolContext
    expect((await checkPermission({}, { toolName: "send_email", input: {}, tool: t }, ctx)).decision).toBe("ask")
    expect((await checkPermission({ allow: ["send_*"] }, { toolName: "send_email", input: {}, tool: t }, ctx)).decision).toBe("allow")
    expect((await checkPermission({ mode: "auto" }, { toolName: "send_email", input: {}, tool: t }, ctx)).decision).toBe("allow")
    expect((await checkPermission({ mode: "auto", deny: ["send_email"] }, { toolName: "send_email", input: {}, tool: t }, ctx)).decision).toBe("deny")
    expect((await checkPermission({}, { toolName: "send_email", input: {}, tool: t }, ctx, ["send_email"])).decision).toBe("allow")
  })
})

describe("code mode types", () => {
  it("turns JSON Schema into TypeScript", () => {
    const ts = jsonSchemaToTs({
      type: "object",
      properties: {
        city: { type: "string", description: "City" },
        unit: { enum: ["c", "f"] },
        days: { type: "array", items: { type: "integer" } },
        "odd-key": { type: ["string", "null"] },
      },
      required: ["city"],
    })
    expect(ts).toContain("/** City */")
    expect(ts).toContain("city: string")
    expect(ts).toContain('unit?: "c" | "f"')
    expect(ts).toContain("days?: number[]")
    expect(ts).toContain('"odd-key"?: string | null')
  })
})

describe("skills", () => {
  it("parses SKILL.md frontmatter", () => {
    const md = `---\nname: pdf-tools\ndescription: "Work with PDFs"\nallowed-tools:\n  - read\n  - write\n---\n# PDF\nUse pypdf.`
    expect(parseSkillMarkdown(md).frontmatter).toEqual({ name: "pdf-tools", description: "Work with PDFs", "allowed-tools": ["read", "write"] })
    const s = skillFromMarkdown(md)
    expect(s.instructions).toBe("# PDF\nUse pypdf.")
    expect(s.allowedTools).toEqual(["read", "write"])
  })
})

describe("tool search", () => {
  it("ranks by name, keywords and description", () => {
    const tools = [
      tool({ name: "create_invoice", description: "Make a new invoice", execute: () => 0 }),
      tool({ name: "send_email", description: "Send an email", keywords: ["mail", "invoice delivery"], execute: () => 0 }),
      tool({ name: "get_weather", description: "Weather", execute: () => 0 }),
    ]
    const hits = keywordIndex.search("invoice", tools.map((t) => ({ tool: t })), 5) as any[]
    expect(hits.map((h) => h.name)).toEqual(["create_invoice", "send_email"])
  })
})

describe("memory tool", () => {
  it("creates, edits and views files", async () => {
    const kv = memoryKV()
    const t = memoryTool(kv)
    const ctx = { context: {} } as ToolContext
    await t.execute!({ command: "create", path: "/memories/notes.md", file_text: "likes tea" }, ctx)
    await t.execute!({ command: "str_replace", path: "/memories/notes.md", old_str: "tea", new_str: "coffee" }, ctx)
    expect(await t.execute!({ command: "view", path: "/memories/notes.md" }, ctx)).toContain("likes coffee")
    expect(await t.execute!({ command: "view" }, ctx)).toContain("/memories/notes.md")
    await expect(async () => t.execute!({ command: "view", path: "/etc/passwd" }, ctx)).rejects.toThrow()
  })
})

describe("streams", () => {
  it("round-trips events through SSE", async () => {
    const hub = new EventHub("r1")
    hub.push({ type: "step-start", step: 0 })
    hub.push({ type: "text-delta", partId: "t", delta: "line\n\nbreak" })
    hub.close()
    const res = sseResponse(hub.subscribe())
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const out = []
    for await (const e of decodeSSE(res.body!)) out.push(e)
    expect(out.map((e) => e.seq)).toEqual([0, 1])
    expect(out[1]!.event).toEqual({ type: "text-delta", partId: "t", delta: "line\n\nbreak" })
  })

  it("lets late readers replay from a seq", async () => {
    const hub = new EventHub("r")
    for (let i = 0; i < 5; i++) hub.push({ type: "step-start", step: i })
    hub.close()
    const seqs = []
    for await (const e of hub.subscribe(2)) seqs.push(e.seq)
    expect(seqs).toEqual([3, 4])
  })
})

describe("sql store", () => {
  it("works on SQLite", async () => {
    const db = new DatabaseSync(":memory:")
    const store = sqlStore({ exec: async (sql, params) => db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>> })
    await store.migrate()
    const base = { agent: "a", headId: null, state: {}, createdAt: 1, updatedAt: 1 }
    await store.createSession({ ...base, id: "s1", ownerId: "u" })
    await store.createSession({ ...base, id: "s2", ownerId: "u", updatedAt: 5 })
    await store.createSession({ ...base, id: "c1", ownerId: "u", parentSessionId: "s1" })
    const page = await store.listSessions({ ownerId: "u" })
    expect(page.sessions.map((s) => s.id)).toEqual(["s2", "s1"])
    expect((await store.listSessions({ parentSessionId: "s1" })).sessions.map((s) => s.id)).toEqual(["c1"])
    await store.putMessage("s1", msg({ id: "m1", createdAt: 2 }))
    await store.putMessage("s1", msg({ id: "m1", createdAt: 2, status: "complete" }))
    expect((await store.getMessages("s1"))[0]!.status).toBe("complete")
    const updated = await store.updateSession("s1", { title: "Hi" })
    expect(updated.title).toBe("Hi")
    await store.appendEvents!("r", [{ seq: 0, runId: "r", event: { type: "step-start", step: 0 } }])
    expect((await store.readEvents!("r")).length).toBe(1)
    await store.deleteSession("s1")
    expect(await store.getSession("s1")).toBeNull()
  })
})
