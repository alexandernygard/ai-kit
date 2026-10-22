import { createKit, defineAgent, jsonSchema, tool, type ToolPart } from "@alexandernygard/ai-kit"
import { driverContract } from "@alexandernygard/ai-kit/testing"
import { describe, expect, it } from "vitest"
import { claude } from "../src/index"

/*
 * Against the real Claude API. Opt-in: `pnpm test:live` (needs ANTHROPIC_API_KEY).
 * AI_KIT_LIVE_MODEL picks the model; the default is the cheapest current one.
 */
const live = !!process.env.AI_KIT_LIVE
const model = process.env.AI_KIT_LIVE_MODEL ?? "claude-haiku-5-5"
const T = 120_000

const weather = tool({
  name: "get_weather",
  description: "The current weather in a city.",
  input: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  readOnly: true,
  execute: ({ city }) => ({ city, tempC: 4 }),
})

const kitWith = (opts: Parameters<typeof defineAgent>[0]) => createKit({ agents: [defineAgent(opts)] })

describe.skipIf(!live)(`live: ${model}`, () => {
  describe("driver contract", () => {
    for (const c of driverContract((s) => claude(s === "error" ? "claude-does-not-exist" : model, { maxTokens: 2000 }))) it(c.name, c.run, T)
  })

  it(
    "runs a tool round trip through the kit with usage and cost",
    async () => {
      const kit = kitWith({ name: "a", model: claude(model, { maxTokens: 2000 }), tools: [weather], instructions: "Answer in one short sentence." })
      const r = await (await kit.createSession()).send("Use get_weather for Oslo and tell me the temperature.").result
      expect(r.finishReason).toBe("stop")
      const call = r.message.parts.find((p): p is ToolPart => p.type === "tool")
      expect(call).toMatchObject({ toolName: "get_weather", state: "output-available" })
      expect(r.text).toMatch(/4/)
      expect(r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0)).toBeGreaterThan(0)
      expect(r.usage.costUsd).toBeGreaterThan(0)
    },
    T,
  )

  it(
    "streams reasoning summaries and sends signed thinking back",
    async () => {
      const kit = kitWith({
        name: "a",
        model: claude(model, { maxTokens: 8000 }),
        tools: [weather],
        settings: { effort: "high", reasoningSummary: true },
      })
      const session = await kit.createSession()
      const r = await session.send("Think it through: is it warmer in Oslo than 10C right now? Use get_weather.").result
      expect(r.finishReason).toBe("stop")
      // The second step sent the first step's thinking back; the API rejects it if the signature is wrong.
      const reasoning = r.message.parts.filter((p) => p.type === "reasoning")
      expect(reasoning.length).toBeGreaterThan(0)
    },
    T,
  )

  it(
    "aborts a run mid-stream",
    async () => {
      const kit = kitWith({ name: "a", model: claude(model, { maxTokens: 4000 }) })
      const run = (await kit.createSession()).send("Write the numbers 1 to 500, one per line.")
      for await (const e of run) if (e.type === "text-delta") break
      run.abort()
      const r = await run.result
      expect(r.finishReason).toBe("aborted")
    },
    T,
  )

  it(
    "maps an API error to a failed run",
    async () => {
      const kit = kitWith({ name: "a", model: claude("claude-does-not-exist", { maxTokens: 100 }) })
      const r = await (await kit.createSession()).send("Hi").result
      expect(r.finishReason).toBe("error")
      expect(r.error?.message).toBeTruthy()
    },
    T,
  )

  it(
    "accepts the server-side fallbacks setting",
    async () => {
      const driver = claude(model, { maxTokens: 200, fallbacks: "default" })
      const kit = kitWith({ name: "a", model: driver })
      const r = await (await kit.createSession()).send("Say hi.").result
      expect(r.finishReason).toBe("stop")
    },
    T,
  )

  it(
    "compacts on the server once the prompt passes the trigger",
    async () => {
      // The smallest trigger the API allows is 50 000 input tokens.
      const filler = Array.from({ length: 4500 }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog.`).join("\n")
      const kit = kitWith({ name: "a", model: claude(model, { maxTokens: 1000, compaction: { trigger: { type: "input_tokens", value: 50_000 } } }) })
      const session = await kit.createSession()
      await session.send(`Remember the code word "heron". Here is a log to ignore:\n${filler}`).result
      const r = await session.send(`Here is more log to ignore:\n${filler}\nWhat was the code word?`).result
      expect(r.finishReason).toBe("stop")
      const messages = await session.messages()
      expect(messages.some((m) => m.parts.some((p) => p.type === "data" && p.name === "ai-kit.raw"))).toBe(true)
      expect(r.text.toLowerCase()).toContain("heron")
    },
    T * 2,
  )
})
