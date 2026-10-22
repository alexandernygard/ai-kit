import { driverContract, type DriverScenario } from "@alexandernygard/ai-kit/testing"
import { describe, it } from "vitest"
import { claude } from "../src/index"

type Event = Record<string, any>

const start = { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } }
const stop = (reason: string) => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 6 } }, { type: "message_stop" }]
const text = (...chunks: string[]) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...chunks.map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index: 0 },
]

const scripts: Record<DriverScenario, Event[] | Error> = {
  text: [start, ...text("po", "ng"), ...stop("end_turn")],
  "tool-call": [
    start,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"Oslo"}' } },
    { type: "content_block_stop", index: 0 },
    ...stop("tool_use"),
  ],
  "tool-result": [start, ...text("It's 4 degrees."), ...stop("end_turn")],
  abort: [start, ...text(...Array.from({ length: 200 }, (_, i) => `${i + 1}\n`)), ...stop("end_turn")],
  error: Object.assign(new Error("model: claude-nope not found"), { status: 404 }),
}

/** A stand-in for `client.beta.messages.create` that streams one script and honours the signal. */
function scripted(script: Event[] | Error) {
  return {
    beta: {
      messages: {
        create: async (_params: unknown, opts: { signal?: AbortSignal }) => {
          if (script instanceof Error) throw script
          return (async function* () {
            for (const e of script) {
              if (opts.signal?.aborted) throw Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" })
              yield e
              await Promise.resolve()
            }
          })()
        },
      },
    },
  } as any
}

describe("claude driver contract", () => {
  for (const c of driverContract((s) => claude("claude-opus-5-5", { client: scripted(scripts[s]) }))) it(c.name, c.run)
})
