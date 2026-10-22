import { driverContract, type DriverScenario } from "@alexandernygard/ai-kit/testing"
import { simulateReadableStream } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { describe, it } from "vitest"
import { aiSdk } from "../src/index"

const finish = (unified: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified, raw: unified },
  usage: { inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 6, text: 6, reasoning: undefined } },
})
const text = (...chunks: string[]) => [
  { type: "text-start", id: "t" },
  ...chunks.map((delta) => ({ type: "text-delta", id: "t", delta })),
  { type: "text-end", id: "t" },
]

const scripts: Record<DriverScenario, any[] | Error> = {
  text: [...text("po", "ng"), finish("stop")],
  "tool-call": [
    { type: "tool-input-start", id: "c1", toolName: "get_weather" },
    { type: "tool-input-delta", id: "c1", delta: '{"city":"Oslo"}' },
    { type: "tool-input-end", id: "c1" },
    { type: "tool-call", toolCallId: "c1", toolName: "get_weather", input: '{"city":"Oslo"}' },
    finish("tool-calls"),
  ],
  "tool-result": [...text("It's 4 degrees."), finish("stop")],
  abort: [...text(...Array.from({ length: 200 }, (_, i) => `${i + 1}\n`)), finish("stop")],
  error: new Error("model not found"),
}

function model(s: DriverScenario) {
  const script = scripts[s]
  return new MockLanguageModelV4({
    doStream: async () => {
      if (script instanceof Error) throw script
      return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...script], chunkDelayInMs: 1 }) }
    },
  })
}

describe("aiSdk driver contract", () => {
  for (const c of driverContract((s) => aiSdk(model(s)))) it(c.name, c.run)
})
