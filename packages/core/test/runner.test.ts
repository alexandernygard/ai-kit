import { describe, expect, expectTypeOf, it } from "vitest"
import { z } from "zod"
import {
  createKit,
  defineAgent,
  defineCommand,
  defineSkill,
  jsonSchema,
  memoryStore,
  pathTo,
  textOf,
  tool,
  toolkit,
  type AgentEvent,
  type ModelTurn,
  type ToolPart,
} from "../src/index"
import { collect, mockModel } from "../src/testing"

const weather = tool({
  name: "get_weather",
  description: "Current weather for a city",
  input: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  readOnly: true,
  execute: ({ city }) => ({ city, tempC: 4 }),
})

const lastToolResult = (turns: ModelTurn[]) => {
  const t = turns.filter((x) => x.role === "tool").at(-1)
  return t?.role === "tool" ? t.content.at(-1) : undefined
}

describe("runs", () => {
  it("streams text, stores messages and titles the session", async () => {
    const model = mockModel([{ text: "Hello there, friend." }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, instructions: "Be kind." })] })
    const session = await kit.createSession()
    const run = session.send("Hi! What's up?")
    const events = await collect(run)
    const result = await run.result
    expect(result.text).toBe("Hello there, friend.")
    expect(result.finishReason).toBe("stop")
    expect(events[0]!.type).toBe("run-start")
    expect(events.filter((e) => e.type === "text-delta").length).toBeGreaterThan(1)
    expect(model.requests[0]!.system[0]!.text).toContain("Be kind.")
    const history = await session.history()
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(history[1]!.status).toBe("complete")
    await session.refresh()
    expect(session.title).toBe("Hi! What's up?")
    expect(session.record.activeRunId).toBeNull()
  })

  it("runs tools and feeds results back", async () => {
    const model = mockModel([{ toolCalls: [{ name: "get_weather", input: { city: "Oslo" } }] }, { text: "It's 4 degrees." }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [weather] })] })
    const run = (await kit.createSession()).send("Weather in Oslo?")
    const result = await run.result
    expect(result.text).toBe("It's 4 degrees.")
    const part = result.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part.state).toBe("output-available")
    expect(part.output).toEqual({ city: "Oslo", tempC: 4 })
    expect(lastToolResult(model.requests[1]!.messages)).toMatchObject({ toolName: "get_weather", output: { type: "json", value: { tempC: 4 } } })
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(["get_weather"])
  })

  it("returns invalid input to the model as an error", async () => {
    const model = mockModel([{ toolCalls: [{ name: "get_weather", input: {} }] }, { text: "ok" }])
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model,
          tools: [
            tool({
              name: "get_weather",
              description: "x",
              input: jsonSchema({ type: "object" }, (v: any) => (v?.city ? { success: true, value: v } : { success: false, error: "city: required" })),
              execute: () => "never",
            }),
          ],
        }),
      ],
    })
    const result = await (await kit.createSession()).send("x").result
    const part = result.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part.state).toBe("output-error")
    expect(part.error).toContain("city: required")
  })

  it("stops at maxSteps", async () => {
    const model = mockModel([{ toolCalls: [{ name: "get_weather", input: { city: "x" } }] }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [weather], limits: { maxSteps: 3 } })] })
    const result = await (await kit.createSession()).send("loop").result
    expect(result.finishReason).toBe("max-steps")
    expect(model.requests.length).toBe(3)
  })

  it("aborts", async () => {
    const slow = tool({ name: "slow", description: "slow", execute: () => new Promise((r) => setTimeout(() => r("done"), 5000)) })
    const model = mockModel([{ toolCalls: [{ name: "slow", input: {} }] }, { text: "never" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [slow] })] })
    const run = (await kit.createSession()).send("go")
    for await (const e of run) if (e.type === "tool-start") run.abort()
    const result = await run.result
    expect(result.finishReason).toBe("aborted")
    expect(result.message.status).toBe("aborted")
  })

  it("falls back to another model when the first fails", async () => {
    const broken = mockModel([{ error: "overloaded" }])
    const backup = mockModel([{ text: "from backup" }], { modelId: "backup" })
    const kit = createKit({ agents: [defineAgent({ name: "a", model: broken, fallbackModels: [backup] })] })
    const result = await (await kit.createSession()).send("hi").result
    expect(result.text).toBe("from backup")
  })

  it("reports model errors", async () => {
    const kit = createKit({ agents: [defineAgent({ name: "a", model: mockModel([{ error: "bad key" }]) })] })
    const result = await (await kit.createSession()).send("hi").result
    expect(result.finishReason).toBe("error")
    expect(result.error?.message).toBe("bad key")
  })

  it("prices usage from the table", async () => {
    const model = mockModel([{ text: "x", usage: { inputTokens: 1_000_000, outputTokens: 0 } }], { modelId: "claude-opus-5-5" })
    const kit = createKit({ agents: [defineAgent({ name: "a", model })] })
    const result = await (await kit.createSession()).send("hi").result
    expect(result.usage.costUsd).toBeCloseTo(4)
  })

  it("rejects a second run while one is active, unless interrupting", async () => {
    const slow = tool({ name: "slow", description: "slow", execute: () => new Promise((r) => setTimeout(() => r("done"), 200)) })
    const model = mockModel([{ toolCalls: [{ name: "slow", input: {} }] }, { text: "done" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [slow] })] })
    const session = await kit.createSession()
    const first = session.send("one")
    for await (const e of first) if (e.type === "tool-start") break
    const second = await session.send("two").result
    expect(second.error?.message).toMatch(/already has a run/)
    const third = session.send("three", { interrupt: true })
    expect((await first.result).finishReason).toBe("aborted")
    expect((await third.result).finishReason).toBe("stop")
  })
})

describe("approvals and client tools", () => {
  const deleteFile = tool({
    name: "delete_file",
    description: "Delete a file",
    input: jsonSchema<{ path: string }>({ type: "object", properties: { path: { type: "string" } } }),
    needsApproval: true,
    destructive: true,
    execute: ({ path }) => `deleted ${path}`,
  })

  it("suspends for approval and resumes", async () => {
    const model = mockModel([{ toolCalls: [{ name: "delete_file", input: { path: "a.txt" }, id: "c1" }] }, { text: "Deleted." }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [deleteFile] })] })
    const session = await kit.createSession()
    const first = await session.send("delete a.txt").result
    expect(first.finishReason).toBe("awaiting-input")
    expect(first.pending.map((p) => p.toolCallId)).toEqual(["c1"])
    expect(first.pending[0]!.approval?.mode).toBe("suspend")

    const second = await session.resume({ c1: { approved: true } }).result
    expect(second.finishReason).toBe("stop")
    expect(second.message.id).toBe(first.message.id)
    const part = second.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part.state).toBe("output-available")
    expect(part.output).toBe("deleted a.txt")
    expect(second.text).toBe("Deleted.")
  })

  it("denies with a message the model sees", async () => {
    const model = mockModel([{ toolCalls: [{ name: "delete_file", input: { path: "a.txt" }, id: "c1" }] }, { text: "OK, I won't." }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [deleteFile] })] })
    const session = await kit.createSession()
    await session.send("delete").result
    const r = await session.respond("c1", { approved: false, message: "keep it" }).result
    const part = r.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part.state).toBe("denied")
    expect(JSON.stringify(lastToolResult(model.requests[1]!.messages))).toContain("keep it")
  })

  it("waits in memory with approvalMode wait", async () => {
    const model = mockModel([{ toolCalls: [{ name: "delete_file", input: { path: "b" }, id: "c1" }] }, { text: "done" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [deleteFile] })] })
    const run = (await kit.createSession()).send("x", { approvalMode: "wait" })
    for await (const e of run) {
      if (e.type === "tool-approval-request") {
        expect(e.mode).toBe("wait")
        expect(run.waitingFor()).toEqual(["c1"])
        run.respond("c1", { approved: true, input: { path: "edited" } })
      }
    }
    const r = await run.result
    expect(r.message.parts.find((p): p is ToolPart => p.type === "tool")!.output).toBe("deleted edited")
  })

  it("remembers approvals for the session", async () => {
    const model = mockModel([
      { toolCalls: [{ name: "delete_file", input: { path: "1" }, id: "c1" }] },
      { toolCalls: [{ name: "delete_file", input: { path: "2" }, id: "c2" }] },
      { text: "done" },
    ])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [deleteFile] })] })
    const session = await kit.createSession()
    await session.send("x").result
    const r = await session.resume({ c1: { approved: true, remember: true } }).result
    expect(r.finishReason).toBe("stop")
  })

  it("decides approvals in code with onToolApproval", async () => {
    const model = mockModel([{ toolCalls: [{ name: "delete_file", input: { path: "x" } }] }, { text: "ok" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [deleteFile] })] })
    const r = await (await kit.createSession()).send("x", { onToolApproval: ({ input }) => ({ approved: (input as { path: string }).path === "x" }) }).result
    expect(r.finishReason).toBe("stop")
  })

  it("suspends for client tools and resumes with the output", async () => {
    const pickColor = tool({ name: "pick_color", description: "Ask the user for a colour" })
    const model = mockModel([{ toolCalls: [{ name: "pick_color", input: {}, id: "c1" }] }, { text: "Blue it is." }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [pickColor] })] })
    const session = await kit.createSession()
    const events: AgentEvent[] = []
    const first = session.send("choose")
    for await (const e of first) events.push(e)
    expect(events.some((e) => e.type === "tool-awaiting-output")).toBe(true)
    expect((await first.result).pending[0]!.runtime).toBe("client")
    const r = await session.resume({ c1: { output: "blue" } }).result
    expect(r.text).toBe("Blue it is.")
    expect(lastToolResult(model.requests[1]!.messages)).toMatchObject({ output: { type: "text", value: "blue" } })
  })

  it("leaves unanswered calls out of the history when the user moves on", async () => {
    const model = mockModel([{ toolCalls: [{ name: "delete_file", input: { path: "a" }, id: "c1" }] }, { text: "fine" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [deleteFile] })] })
    const session = await kit.createSession()
    await session.send("delete").result
    await session.send("never mind").result
    const turns = model.requests[1]!.messages
    expect(JSON.stringify(turns)).not.toContain("c1")
  })
})

describe("permissions and hooks", () => {
  const write = tool({ name: "write_db", description: "write", execute: () => "written" })

  it("applies deny rules and plan mode", async () => {
    const model = mockModel([{ toolCalls: [{ name: "write_db", input: {} }, { name: "get_weather", input: { city: "a" } }] }, { text: "ok" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [write, weather], permissions: { mode: "plan" } })] })
    const r = await (await kit.createSession()).send("x").result
    const parts = r.message.parts.filter((p): p is ToolPart => p.type === "tool")
    expect(parts.find((p) => p.toolName === "write_db")!.state).toBe("output-error")
    expect(parts.find((p) => p.toolName === "get_weather")!.state).toBe("output-available")
  })

  it("matches rules on permission keys", async () => {
    const bash = tool({
      name: "bash",
      description: "run",
      input: jsonSchema<{ cmd: string }>({ type: "object", properties: { cmd: { type: "string" } } }),
      permissionKey: (i) => i.cmd,
      execute: ({ cmd }) => cmd,
    })
    const model = mockModel([{ toolCalls: [{ name: "bash", input: { cmd: "git status" } }, { name: "bash", input: { cmd: "rm -rf /" } }] }, { text: "ok" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [bash], permissions: { mode: "ask", allow: ["bash(git *)"] } })] })
    const r = await (await kit.createSession()).send("x").result
    const parts = r.message.parts.filter((p): p is ToolPart => p.type === "tool")
    expect(parts[0]!.state).toBe("output-available")
    expect(parts[1]!.state).toBe("awaiting-approval")
  })

  it("lets hooks rewrite input and output, and keep the agent going", async () => {
    const model = mockModel([{ toolCalls: [{ name: "get_weather", input: { city: "oslo" } }] }, { text: "first" }, { text: "second" }])
    let stops = 0
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model,
          tools: [weather],
          hooks: {
            beforeToolCall: (c) => ({ decision: "allow", input: { city: String((c.input as { city: string }).city).toUpperCase() } }),
            afterToolCall: (c) => ({ output: { ...(c.output as object), audited: true } }),
            onStop: () => (stops++ === 0 ? { continue: "Check again." } : undefined),
          },
        }),
      ],
    })
    const r = await (await kit.createSession()).send("x").result
    const part = r.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part.output).toEqual({ city: "OSLO", tempC: 4, audited: true })
    expect(r.text).toBe("second")
    expect(JSON.stringify(model.requests[2]!.messages.at(-1))).toContain("Check again.")
  })

  it("lets a hook's allow skip the approval, but not a deny rule", async () => {
    const send = tool({ name: "send_email", description: "send", needsApproval: true, execute: () => "sent" })
    const model = mockModel([{ toolCalls: [{ name: "send_email", input: {} }] }, { text: "ok" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [send], hooks: { beforeToolCall: () => ({ decision: "allow" }) } })] })
    const r = await (await kit.createSession()).send("x").result
    expect(r.finishReason).toBe("stop")
    const model2 = mockModel([{ toolCalls: [{ name: "send_email", input: {} }] }, { text: "ok" }])
    const kit2 = createKit({ agents: [defineAgent({ name: "a", model: model2, tools: [send], permissions: { deny: ["send_*"] }, hooks: { beforeToolCall: () => ({ decision: "allow" }) } })] })
    const r2 = await (await kit2.createSession()).send("x").result
    expect(r2.message.parts.find((p): p is ToolPart => p.type === "tool")!.state).toBe("output-error")
  })

  it("blocks user messages from hooks", async () => {
    const kit = createKit({
      agents: [defineAgent({ name: "a", model: mockModel([{ text: "x" }]) })],
      hooks: { onUserMessage: (m) => (textOf(m).includes("secret") ? { block: "No secrets." } : undefined) },
    })
    const r = await (await kit.createSession()).send("my secret").result
    expect(r.error?.message).toBe("No secrets.")
  })
})

describe("structured output", () => {
  it("uses a tool when the model has no native JSON output", async () => {
    const model = mockModel([{ toolCalls: [{ name: "structured_output", input: { name: "Ada", age: 36 } }] }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model })] })
    const schema = { type: "object", properties: { name: { type: "string" }, age: { type: "number" } }, required: ["name"] }
    const r = await kit.generate("Who wrote the first program?", { output: schema })
    expect(r.output).toEqual({ name: "Ada", age: 36 })
    expect(model.requests.length).toBe(1)
    expect((await kit.listSessions()).sessions.length).toBe(0)
  })

  it("types the output from the schema", async () => {
    const model = mockModel([{ toolCalls: [{ name: "structured_output", input: { total: 120, due: "2026-11-01" } }] }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model })] })
    const r = await kit.generate("Extract the invoice", { output: z.object({ total: z.number(), due: z.string() }) })
    expectTypeOf(r.output).toEqualTypeOf<{ total: number; due: string } | undefined>()
    expect(r.output?.total).toBe(120)
    expectTypeOf((await kit.generate("x")).output).toBeUnknown()
  })

  it("uses the tool, not JSON mode, when the agent has tools", async () => {
    const model = mockModel([{ toolCalls: [{ name: "structured_output", input: { city: "Oslo" } }] }], { capabilities: { structuredOutput: true } })
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [weather] })] })
    const r = await kit.generate("x", { output: { type: "object", properties: { city: { type: "string" } } } })
    expect(model.requests[0]!.responseFormat).toBeUndefined()
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(["get_weather", "structured_output"])
    expect(r.output).toEqual({ city: "Oslo" })
  })

  it("parses native JSON and nudges once on bad output", async () => {
    const model = mockModel([{ text: "not json" }, { text: '{"ok":true}' }], { capabilities: { structuredOutput: true } })
    const kit = createKit({ agents: [defineAgent({ name: "a", model })] })
    const r = await kit.generate("x", { output: { type: "object", properties: { ok: { type: "boolean" } } } })
    expect(r.output).toEqual({ ok: true })
    expect(model.requests[0]!.responseFormat).toBeDefined()
  })
})

describe("tool search, skills, code mode", () => {
  it("hides deferred tools until search_tools loads them", async () => {
    const refund = tool({ name: "issue_refund", description: "Refund an order to the customer's card", keywords: ["money back"], defer: true, execute: () => "refunded" })
    const model = mockModel([
      { toolCalls: [{ name: "search_tools", input: { query: "refund an order" } }] },
      { toolCalls: [{ name: "issue_refund", input: {} }] },
      { text: "Refunded." },
    ])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [weather, refund] })] })
    const session = await kit.createSession()
    const r = await session.send("refund me").result
    expect(r.text).toBe("Refunded.")
    expect(model.requests[0]!.tools.map((t) => t.name).sort()).toEqual(["get_weather", "search_tools"])
    expect(model.requests[1]!.tools.map((t) => t.name)).toContain("issue_refund")
    await session.refresh()
    expect(session.record.state["ai-kit.activeTools"]).toEqual(["issue_refund"])
  })

  it("loads deferred toolkits by name and adds their instructions", async () => {
    const kit1 = toolkit({ name: "github", description: "GitHub issues and PRs", instructions: "Use owner/repo.", defer: true, tools: [tool({ name: "list_issues", description: "List issues", execute: () => [] })] })
    const model = mockModel([{ toolCalls: [{ name: "search_tools", input: { toolkit: "github" } }] }, { text: "ok" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [kit1] })] })
    await (await kit.createSession()).send("x").result
    expect(model.requests[0]!.system.map((s) => s.text).join()).toContain("github (1 tools)")
    expect(model.requests[1]!.tools.map((t) => t.name)).toContain("list_issues")
    expect(model.requests[1]!.system.map((s) => s.text).join()).toContain("Use owner/repo.")
  })

  it("loads skills on demand with their tools", async () => {
    const skill = defineSkill({
      name: "refunds",
      description: "How to handle refund requests",
      instructions: "Always check the order date first.",
      files: { "policy.md": "30 days." },
      tools: [tool({ name: "check_order_date", description: "Order date", execute: () => "2026-10-01" })],
    })
    const model = mockModel([
      { toolCalls: [{ name: "load_skill", input: { name: "refunds" } }] },
      { toolCalls: [{ name: "read_skill_file", input: { skill: "refunds", path: "policy.md" } }] },
      { text: "ok" },
    ])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, skills: [skill] })] })
    const r = await (await kit.createSession()).send("refund").result
    expect(model.requests[0]!.system[0]!.text).toContain("refunds: How to handle refund requests")
    expect(model.requests[0]!.tools.map((t) => t.name)).not.toContain("check_order_date")
    expect(model.requests[1]!.tools.map((t) => t.name)).toContain("check_order_date")
    const parts = r.message.parts.filter((p): p is ToolPart => p.type === "tool")
    expect(parts[0]!.output).toContain("Always check the order date first.")
    expect(parts[1]!.output).toBe("30 days.")
  })

  it("runs code that calls tools, showing nested calls", async () => {
    const add = tool({
      name: "add",
      description: "Add numbers",
      input: jsonSchema<{ a: number; b: number }>({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }),
      execute: ({ a, b }) => a + b,
    })
    const code = "const x = await tools.add({ a: 1, b: 2 }); const y = await tools.add({ a: x, b: 10 }); console.log('x', x); return y"
    const model = mockModel([{ toolCalls: [{ name: "run_code", input: { code }, id: "rc" }] }, { text: "13" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [add], codeMode: true })] })
    const r = await (await kit.createSession()).send("x").result
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(["run_code"])
    expect(model.requests[0]!.tools[0]!.description).toContain("add(input: {")
    const parts = r.message.parts.filter((p): p is ToolPart => p.type === "tool")
    expect(parts.filter((p) => p.parentToolCallId === "rc").map((p) => p.output)).toEqual([3, 13])
    const runCode = parts.find((p) => p.toolCallId === "rc")!
    expect(JSON.parse(runCode.output as string)).toEqual({ result: 13, logs: "x 3" })
    expect(JSON.stringify(model.requests[1]!.messages)).not.toContain('"toolName":"add"')
  })

  it("reports code errors to the model", async () => {
    const model = mockModel([{ toolCalls: [{ name: "run_code", input: { code: "throw new Error('boom')" } }] }, { text: "sorry" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [weather], codeMode: true })] })
    const r = await (await kit.createSession()).send("x").result
    const part = r.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part.state).toBe("output-error")
    expect(part.error).toContain("boom")
  })
})

describe("subagents", () => {
  it("runs a subagent in a child session", async () => {
    const researcher = defineAgent({ name: "researcher", description: "Finds facts", model: mockModel([{ text: "Oslo has 700k people." }]) })
    const model = mockModel([{ toolCalls: [{ name: "task", input: { agent: "researcher", prompt: "Population of Oslo?" }, id: "t1" }] }, { text: "About 700k." }])
    const kit = createKit({ agents: [defineAgent({ name: "lead", model, subagents: [researcher] })] })
    const session = await kit.createSession()
    const events = await collect(session.send("How big is Oslo?"))
    const r = await session.send("thanks").result
    void r
    const sub = events.filter((e) => e.type === "subagent")
    expect(sub.length).toBeGreaterThan(0)
    const children = await session.children()
    expect(children.length).toBe(1)
    expect(children[0]!.record.parentToolCallId).toBe("t1")
    const childHistory = await children[0]!.history()
    expect(textOf(childHistory[1])).toBe("Oslo has 700k people.")
    expect(lastToolResult(model.requests[1]!.messages)).toMatchObject({ output: { type: "text", value: "Oslo has 700k people." } })
    expect((await kit.listSessions()).sessions.length).toBe(1)
  })
})

describe("branches and forks", () => {
  it("edits, regenerates, switches branches and forks", async () => {
    const model = mockModel([{ text: "A1" }, { text: "A2" }, { text: "B1" }, { text: "C1" }])
    const kit = createKit({ agents: [defineAgent({ name: "a", model })] })
    const s = await kit.createSession()
    const first = await s.send("Q1").result
    const regen = await s.regenerate().result
    expect(regen.text).toBe("A2")
    expect(regen.message.parentId).toBe(first.message.parentId)
    expect((await s.versions(first.message.id)).map((m) => textOf(m))).toEqual(["A1", "A2"])

    const userId = first.message.parentId!
    const edited = await s.edit(userId, "Q1 edited").result
    expect(edited.text).toBe("B1")
    expect((await s.history()).map(textOf)).toEqual(["Q1 edited", "B1"])

    await s.switchBranch(first.message.id)
    expect((await s.history()).map(textOf)).toEqual(["Q1", "A1"])

    const fork = await s.fork()
    expect(fork.record.forkedFrom).toEqual({ sessionId: s.id, messageId: first.message.id })
    const forked = await fork.history()
    expect(forked.map(textOf)).toEqual(["Q1", "A1"])
    expect(forked[0]!.id).not.toBe(userId)
    const cont = await fork.send("Q2").result
    expect(cont.text).toBe("C1")
    expect((await s.history()).length).toBe(2)
    const all = await fork.messages()
    expect(pathTo(all, fork.headId).length).toBe(2)
  })
})

describe("commands, plugins, compaction", () => {
  it("expands slash commands", async () => {
    const model = mockModel([{ text: "ok" }])
    const kit = createKit({
      agents: [defineAgent({ name: "a", model })],
      commands: [defineCommand({ name: "review", description: "Review a file", prompt: (args) => `Review ${args} carefully.` })],
    })
    await (await kit.createSession()).send("/review app.ts").result
    expect(JSON.stringify(model.requests[0]!.messages)).toContain("Review app.ts carefully.")
    expect((await kit.agents())[0]!.commands[0]!.name).toBe("review")
  })

  it("applies plugins with async setup", async () => {
    const { definePlugin } = await import("../src/index")
    const model = mockModel([{ toolCalls: [{ name: "billing__invoice", input: {} }] }, { text: "ok" }])
    const kit = createKit({
      agents: [defineAgent({ name: "a", model })],
      plugins: [
        definePlugin({
          name: "billing",
          namespaceTools: true,
          instructions: "Amounts are in NOK.",
          async setup(api) {
            await Promise.resolve()
            api.addTools([tool({ name: "invoice", description: "Get invoice", execute: () => ({ total: 100 }) })])
          },
        }),
      ],
    })
    const r = await (await kit.createSession()).send("invoice?").result
    expect(model.requests[0]!.system[0]!.text).toContain("Amounts are in NOK.")
    expect(r.message.parts.find((p): p is ToolPart => p.type === "tool")!.output).toEqual({ total: 100 })
  })

  it("compacts when the context fills", async () => {
    const summarizer = mockModel([{ text: "User asked about Oslo several times." }])
    const big = "word ".repeat(400)
    const model = mockModel([{ text: big }])
    const kit = createKit({
      agents: [defineAgent({ name: "a", model, compaction: { contextWindow: 1500, keepRecent: 2, model: summarizer } })],
    })
    const s = await kit.createSession()
    for (let i = 0; i < 4; i++) await s.send(`question ${i} ${big}`).result
    expect(summarizer.requests.length).toBeGreaterThan(0)
    await s.refresh()
    expect(s.record.state["ai-kit.compaction"]).toMatchObject({ summary: "User asked about Oslo several times." })
    const last = model.requests.at(-1)!.messages
    expect(JSON.stringify(last[0])).toContain("summary of the earlier conversation")
  })
})

describe("stores", () => {
  it("lists sessions by owner with paging", async () => {
    const store = memoryStore()
    const kit = createKit({ store, agents: [defineAgent({ name: "a", model: mockModel([{ text: "x" }]) })] })
    for (let i = 0; i < 5; i++) await kit.createSession({ ownerId: i % 2 ? "bob" : "ann" })
    const ann = await kit.listSessions({ ownerId: "ann", limit: 2 })
    expect(ann.sessions.length).toBe(2)
    expect(ann.nextCursor).toBe("2")
    const rest = await kit.listSessions({ ownerId: "ann", limit: 2, cursor: ann.nextCursor })
    expect(rest.sessions.length).toBe(1)
  })

  it("persists run events for reconnecting", async () => {
    const kit = createKit({ agents: [defineAgent({ name: "a", model: mockModel([{ text: "hello world" }]) })] })
    const run = (await kit.createSession()).send("x")
    await run.result
    const stored = await kit.store.readEvents!(run.id, 2)
    expect(stored[0]!.seq).toBe(3)
    expect(stored.at(-1)!.event.type).toBe("run-finish")
  })
})
