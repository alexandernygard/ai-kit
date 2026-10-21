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
  type AgentEvent,
  type ModelTurn,
} from "../src/index"
import { collect, mockModel } from "../src/testing"

const textOfTurn = (t: ModelTurn | undefined) => JSON.stringify(t?.content ?? [])

describe("context providers", () => {
  it("attaches turn context to the newest user message and system context to the system prompt", async () => {
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

    const req = model.requests[1]!
    expect(req.system[0]!.text).toBe("Be brief.")
    expect(req.system.at(-1)!.text).toContain('<context name="rules">\nPrices in NOK.')
    const users = req.messages.filter((t) => t.role === "user")
    // Only the newest user turn carries the turn context; the earlier one is left as it was.
    expect(textOfTurn(users[0])).not.toContain("context name")
    expect(textOfTurn(users[1])).toContain('<context name=\\"user\\">')
    expect(textOfTurn(users[1])).toContain("Ada")
    expect(textOfTurn(users[1])).toContain("second")
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
    expect(est.tokens).toBe(est.breakdown!.system + est.breakdown!.tools + est.breakdown!.messages)
    expect(usage[1]).toMatchObject({ tokens: 10_000, ratio: 0.1 })

    const msg = (await run.result).message
    // The stored message keeps the latest reading, with the estimate's breakdown.
    expect(msg.contextUsage).toMatchObject({ source: "provider", tokens: 10_000, breakdown: { system: 100 } })
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
