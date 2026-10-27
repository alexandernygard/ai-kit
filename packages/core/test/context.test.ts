import { describe, expect, it } from "vitest"
import {
  clientContext,
  contextWindowFor,
  createKit,
  currentTime,
  defineAgent,
  defineContext,
  definePlugin,
  tool,
  toModelTurns,
  type AgentEvent,
  type ContextUsage,
  type Message,
  type ModelTurn,
} from "../src/index"
import { collect, mockModel } from "../src/testing"

const textOfTurn = (t: ModelTurn | undefined) => JSON.stringify(t?.content ?? [])

describe("context providers", () => {
  it("stores context in the conversation: turn context as user text, system context as a system message", async () => {
    const model = mockModel([{ text: "ok" }, { text: "ok again" }])
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model,
          instructions: "Be brief.",
          contextProviders: [
            defineContext({ name: "user", get: ({ context }) => ({ name: context.name, plan: "pro" }) }),
            defineContext({ name: "rules", placement: "system", get: () => "Prices in NOK." }),
          ],
        }),
      ],
    })
    const s = await kit.createSession()
    await s.send("first", { context: { name: "Ada" } }).result
    await s.send("second", { context: { name: "Ada" } }).result

    const [first, second] = model.requests
    // The system prompt never carries context, so it stays the same.
    expect(second!.system).toEqual([{ text: "Be brief.", cache: true }])
    expect(first!.messages.map((t) => t.role)).toEqual(["user", "system"])
    expect(textOfTurn(first!.messages[0])).toContain('<context name=\\"user\\">')
    expect(textOfTurn(first!.messages[1])).toContain('<context name=\\"rules\\">\\nPrices in NOK.')
    // The second request repeats the first word for word and adds to it. Unchanged context isn't sent again.
    expect(second!.messages.slice(0, 2)).toEqual(first!.messages)
    expect(second!.messages.map((t) => t.role)).toEqual(["user", "system", "assistant", "user"])
    expect(textOfTurn(second!.messages[3])).not.toContain("context name")
  })

  it("only ever appends to the history, across steps and runs", async () => {
    let n = 0
    const model = mockModel(
      [{ toolCalls: [{ name: "big", input: {} }] }, { toolCalls: [{ name: "big", input: {} }] }, { text: "done" }],
      { capabilities: { contextManagement: true } },
    )
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model,
          tools: [tool({ name: "big", description: "big", execute: () => "x".repeat(10_000) })],
          contextProviders: [defineContext({ name: "tick", refresh: "step", get: () => `tick ${++n}` })],
        }),
      ],
    })
    const s = await kit.createSession()
    await s.send("go").result
    await s.send("again").result
    const reqs = model.requests
    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1]!.messages
      expect(reqs[i]!.messages.slice(0, prev.length)).toEqual(prev)
    }
    // Old tool outputs aren't cleared when the driver manages context.
    expect(JSON.stringify(reqs.at(-1)!.messages)).not.toContain("Output removed")
    expect(reqs.at(-1)!.contextManagement).toEqual({ compactAtTokens: 160_000 })
  })

  it("computes run-scoped providers once and step-scoped providers every step", async () => {
    let runCalls = 0
    let stepCalls = 0
    const model = mockModel([{ toolCalls: [{ name: "noop", input: {} }] }, { toolCalls: [{ name: "noop", input: {} }] }, { text: "done" }])
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model,
          tools: [tool({ name: "noop", description: "noop", execute: () => "ok" })],
          contextProviders: [
            defineContext({ name: "once", get: () => `run ${++runCalls}` }),
            defineContext({ name: "each", refresh: "step", get: ({ step }) => `step ${step} call ${++stepCalls}` }),
          ],
        }),
      ],
    })
    await (await kit.createSession()).send("go").result
    expect(runCalls).toBe(1)
    expect(stepCalls).toBe(3)
    expect(JSON.stringify(model.requests[2]!.messages)).toContain("step 2 call 3")
  })

  it("skips empty providers and reports failing ones without breaking the run", async () => {
    const model = mockModel([{ text: "ok" }])
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model,
          contextProviders: [
            defineContext({ name: "nothing", get: () => undefined }),
            defineContext({
              name: "broken",
              get: () => {
                throw new Error("db down")
              },
            }),
          ],
        }),
      ],
    })
    const run = (await kit.createSession()).send("hi")
    const events = await collect(run)
    expect((await run.result).text).toBe("ok")
    expect(events.find((e) => e.type === "status" && e.status === "context-error")).toMatchObject({ detail: "broken: db down" })
    expect(JSON.stringify(model.requests[0]!.messages)).not.toContain("context name")
  })

  it("comes from kit, plugins and agents, in that order, and plugins can add them in setup", async () => {
    const model = mockModel([{ text: "ok" }])
    const kit = createKit({
      agents: [defineAgent({ name: "a", model, contextProviders: [defineContext({ name: "c", get: () => "agent" })] })],
      contextProviders: [defineContext({ name: "a", get: () => "kit" })],
      plugins: [
        definePlugin({
          name: "p",
          setup: (api) => api.addContext([defineContext({ name: "b", get: () => "plugin" })]),
        }),
      ],
    })
    await (await kit.createSession()).send("hi").result
    const text = JSON.stringify(model.requests[0]!.messages)
    expect(text.indexOf("kit")).toBeLessThan(text.indexOf("plugin"))
    expect(text.indexOf("plugin")).toBeLessThan(text.indexOf("agent"))
  })

  it("shows client context only through the clientContext provider, and to tools", async () => {
    let seenByTool: unknown
    const model = mockModel([{ toolCalls: [{ name: "where", input: {} }] }, { text: "ok" }])
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model,
          tools: [tool({ name: "where", description: "page", execute: (_, ctx) => (seenByTool = ctx.clientContext) })],
          contextProviders: [clientContext({ pick: ["route"] })],
        }),
      ],
    })
    await (await kit.createSession()).send("where am I?", { clientContext: { route: "/orders/A1", secret: "x" } }).result
    const turns = JSON.stringify(model.requests[0]!.messages)
    expect(turns).toContain("/orders/A1")
    expect(turns).toContain("treat as user input")
    expect(turns).not.toContain("secret")
    expect(seenByTool).toEqual({ route: "/orders/A1", secret: "x" })
  })
})

describe("context usage", () => {
  it("reports an estimate before each call and the provider count after", async () => {
    const model = mockModel([{ text: "hello", usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 9000 } }], { capabilities: { contextWindow: 100_000 } })
    const kit = createKit({
      agents: [defineAgent({ name: "a", model, instructions: "x".repeat(400), contextProviders: [defineContext({ name: "user", get: () => "y".repeat(80) })] })],
    })
    const run = (await kit.createSession()).send("hi")
    const usage = (await collect(run)).filter((e): e is Extract<AgentEvent, { type: "context-usage" }> => e.type === "context-usage")
    expect(usage.map((u) => u.source)).toEqual(["estimate", "provider"])
    const est = usage[0]!
    expect(est.window).toBe(100_000)
    expect(est.compactAt).toBe(0.8)
    expect(est.breakdown!.system).toBe(100)
    // 80 characters plus the <context name="user"> wrapper.
    expect(est.breakdown!.context).toEqual([{ name: "user", tokens: Math.ceil(`<context name="user">\n${"y".repeat(80)}\n</context>`.length / 4) }])
    expect(est.breakdown!.output).toBe(0)
    expect(est.tokens).toBe(sections(est.breakdown!))
    expect(usage[1]).toMatchObject({ tokens: 10_000, ratio: 0.1 })
    // The provider's count is split in the estimate's proportions, plus the reply.
    const measured = usage[1]!.breakdown!
    expect(measured.output).toBe(100)
    expect(sections(measured)).toBe(10_000)
    expect(measured.system / (measured.system + measured.tools + measured.messages)).toBeCloseTo(est.breakdown!.system / (est.tokens - est.breakdown!.context[0]!.tokens), 2)

    const msg = (await run.result).message
    expect(msg.contextUsage).toMatchObject({ source: "provider", tokens: 10_000 })
  })

  it("counts every stored copy of a context once, outside messages", async () => {
    const model = mockModel([{ text: "one" }, { text: "two" }])
    let n = 0
    const kit = createKit({ agents: [defineAgent({ name: "a", model, contextProviders: [defineContext({ name: "board", get: () => `board ${++n} ${"z".repeat(396)}` })] })] })
    const session = await kit.createSession()
    await session.send("first").result
    const events = await collect(session.send("second"))
    const est = events.find((e): e is Extract<AgentEvent, { type: "context-usage" }> => e.type === "context-usage" && e.source === "estimate")!
    // Two board snapshots are in the history now, about 110 tokens each with the wrapper.
    expect(est.breakdown!.context).toHaveLength(1)
    expect(est.breakdown!.context[0]!.tokens).toBeGreaterThan(200)
    expect(est.breakdown!.messages).toBeLessThan(est.breakdown!.context[0]!.tokens)
    expect(est.tokens).toBe(sections(est.breakdown!))
  })

  it("finds the window from the model id, and lets the kit override it", async () => {
    expect(contextWindowFor("claude-opus-5-5")).toBe(1_000_000)
    expect(contextWindowFor("anthropic:claude-haiku-4-5")).toBe(200_000)
    expect(contextWindowFor("gpt-5.5")).toBeUndefined()
    const model = mockModel([{ text: "ok" }], { modelId: "acme-large" })
    const kit = createKit({ agents: [defineAgent({ name: "a", model })], contextWindows: { "acme-": 64_000 } })
    const events = await collect((await kit.createSession()).send("hi"))
    expect(events.find((e) => e.type === "context-usage")).toMatchObject({ window: 64_000 })
  })
})

describe("append-only requests", () => {
  const lookup = tool({ name: "lookup", description: "Look up an order", defer: true, execute: () => "found" })

  it("declares deferred tools up front when the driver searches tools itself", async () => {
    const model = mockModel([{ toolCalls: [{ name: "lookup", input: {} }] }, { text: "done" }], { capabilities: { toolSearch: true } })
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [lookup, tool({ name: "ping", description: "ping", execute: () => "pong" })] })] })
    const r = await (await kit.createSession()).send("Find order 7").result
    expect(r.text).toBe("done")
    for (const req of model.requests) {
      expect(req.tools.map((t) => [t.name, t.defer ?? false])).toEqual([
        ["ping", false],
        ["lookup", true],
      ])
    }
  })

  it("turns a forced tool choice into a system message for models that reject it", async () => {
    const model = mockModel([{ text: "ok" }], { capabilities: { forcedToolChoice: false } })
    const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [tool({ name: "ping", description: "ping", execute: () => "pong" })] })] })
    await (await kit.createSession()).send("hi", { toolChoice: { tool: "ping" } }).result
    const req = model.requests[0]!
    expect(req.toolChoice).toBe("auto")
    expect(req.messages.at(-1)).toEqual({ role: "system", content: [{ type: "text", text: "Use the `ping` tool for this request." }] })
  })

  it("leaves out reasoning signed before a client-side compaction", () => {
    const user = (id: string, text: string): Message => ({ id, role: "user", parentId: null, createdAt: 0, parts: [{ type: "text", id: `${id}t`, text }] })
    const assistant = (id: string, text: string): Message => ({
      id,
      role: "assistant",
      parentId: null,
      createdAt: 0,
      status: "complete",
      parts: [
        { type: "reasoning", id: `${id}r`, text: `thinking ${id}`, providerMetadata: { anthropic: { signature: "s" } } },
        { type: "text", id: `${id}t`, text },
      ],
    })
    const path = [user("u1", "a"), assistant("a1", "b"), user("u2", "c"), assistant("a2", "d"), user("u3", "e"), assistant("a3", "f")]
    const turns = toModelTurns(path, { compaction: { uptoMessageId: "a1", summary: "earlier", reasoningBefore: { messageId: "a3", parts: 1 } } })
    const json = JSON.stringify(turns)
    expect(json).toContain("earlier")
    expect(json).not.toContain("thinking a1")
    expect(json).not.toContain("thinking a2")
    expect(json).not.toContain("thinking a3")
    // Without a cutoff, reasoning is sent back.
    expect(JSON.stringify(toModelTurns(path))).toContain("thinking a3")
  })
})

function sections(b: NonNullable<ContextUsage["breakdown"]>) {
  return b.system + b.tools + b.messages + b.context.reduce((n, c) => n + c.tokens, 0) + (b.output ?? 0)
}
