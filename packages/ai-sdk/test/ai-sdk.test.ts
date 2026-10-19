import { createKit, defineAgent, jsonSchema, tool, type ToolPart } from "@alexandernygard/ai-kit"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { describe, expect, it } from "vitest"
import { aiSdk } from "../src/index"

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: 3, cacheWrite: undefined },
  outputTokens: { total: o, text: o, reasoning: undefined },
})

const finish = (unified: "stop" | "tool-calls", i = 10, o = 5) => ({ type: "finish" as const, finishReason: { unified, raw: unified }, usage: usage(i, o) })

function stream(chunks: any[]) {
  return { stream: simulateReadableStream({ chunks }) }
}

describe("aiSdk driver", () => {
  it("runs a tool loop through an AI SDK model", async () => {
    const model = new MockLanguageModelV4({
      provider: "anthropic.messages",
      modelId: "claude-opus-5-5",
      doStream: [
        stream([
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r" },
          { type: "reasoning-delta", id: "r", delta: "Need weather." },
          { type: "reasoning-end", id: "r", providerMetadata: { anthropic: { signature: "sig" } } },
          { type: "tool-input-start", id: "c1", toolName: "get_weather" },
          { type: "tool-input-delta", id: "c1", delta: '{"city":"Oslo"}' },
          { type: "tool-input-end", id: "c1" },
          { type: "tool-call", toolCallId: "c1", toolName: "get_weather", input: '{"city":"Oslo"}' },
          finish("tool-calls"),
        ]),
        stream([
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "It's " },
          { type: "text-delta", id: "t", delta: "4C." },
          { type: "text-end", id: "t" },
          finish("stop", 20, 3),
        ]),
      ],
    })
    const weather = tool({
      name: "get_weather",
      description: "Weather",
      input: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: ({ city }) => ({ city, tempC: 4 }),
    })
    const kit = createKit({ agents: [defineAgent({ name: "a", model: aiSdk(model), instructions: "Be brief.", tools: [weather] })] })
    const r = await (await kit.createSession()).send("Weather in Oslo?").result

    expect(r.text).toBe("It's 4C.")
    expect(r.usage.inputTokens).toBe(30)
    expect(r.usage.cacheReadTokens).toBe(6)
    expect(r.usage.costUsd).toBeGreaterThan(0)
    const part = r.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part.output).toEqual({ city: "Oslo", tempC: 4 })
    const reasoning = r.message.parts.find((p) => p.type === "reasoning")
    expect(reasoning).toMatchObject({ text: "Need weather.", providerMetadata: { anthropic: { signature: "sig" } } })

    const first = model.doStreamCalls[0]!
    expect(first.prompt[0]).toMatchObject({ role: "system", content: "Be brief.", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } })
    expect(first.tools?.[0]).toMatchObject({ type: "function", name: "get_weather" })

    const second = model.doStreamCalls[1]!.prompt
    const assistant = second.find((m) => m.role === "assistant")!
    expect(JSON.stringify(assistant.content)).toContain("sig")
    const toolMsg = second.find((m) => m.role === "tool")!
    expect(JSON.stringify(toolMsg.content)).toContain('"tempC":4')
    const last = second.at(-1) as any
    expect(last.content.at(-1).providerOptions.anthropic.cacheControl).toEqual({ type: "ephemeral" })
  })

  it("passes effort and errors through", async () => {
    const model = new MockLanguageModelV4({
      provider: "openai.responses",
      modelId: "gpt-5.5",
      doStream: async () => {
        throw new Error("401 bad key")
      },
    })
    const kit = createKit({ agents: [defineAgent({ name: "a", model: aiSdk(model, { maxRetries: 0 }), settings: { effort: "high" } })] })
    const r = await (await kit.createSession()).send("hi").result
    expect(r.finishReason).toBe("error")
    expect(r.error?.message).toContain("401")
    expect(model.doStreamCalls[0]!.reasoning).toBe("high")
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).not.toContain("cacheControl")
  })
})
