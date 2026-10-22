import type { ModelDriver, ModelEvent, ModelRequest, ToolSpec } from "./driver"

/**
 * The behaviour every `ModelDriver` must have for the runner to work: streamed text, tool calls,
 * tool results, abort, usage and errors. Test-framework agnostic: each case throws on failure.
 *
 * ```ts
 * for (const c of driverContract((scenario) => myDriver(scenario))) it(c.name, c.run)
 * ```
 *
 * The factory gets the scenario so a scripted driver can answer it. A real model gets prompts it
 * follows on its own; for `error`, return a driver whose call fails (an unknown model id).
 */
export type DriverScenario = "text" | "tool-call" | "tool-result" | "abort" | "error"

export interface DriverContractCase {
  name: string
  scenario: DriverScenario
  run(): Promise<void>
}

export const CONTRACT_TOOL: ToolSpec = {
  name: "get_weather",
  description: "The current weather in a city.",
  inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
}

const request = (r: Partial<ModelRequest>, signal = new AbortController().signal): ModelRequest => ({
  system: [{ text: "You are a test fixture. Follow the instructions exactly and keep answers under ten words." }],
  messages: [],
  tools: [],
  settings: { maxOutputTokens: 1000 },
  signal,
  ...r,
})

function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Driver contract: ${message}`)
}

async function drain(driver: ModelDriver, req: ModelRequest, onEvent?: (e: ModelEvent) => void) {
  const events: ModelEvent[] = []
  for await (const e of driver.stream(req)) {
    events.push(e)
    onEvent?.(e)
  }
  return events
}

/** Text parts are closed, `finish` comes once and last, and usage was counted. */
function checkCompleted(events: ModelEvent[], reason: string) {
  const error = events.find((e) => e.type === "error")
  check(!error, `unexpected error event: ${String((error as { error?: unknown } | undefined)?.error)}`)
  const finishes = events.filter((e) => e.type === "finish")
  check(finishes.length === 1, `expected one finish event, got ${finishes.length}`)
  const finish = events.at(-1)
  check(finish?.type === "finish", "finish must be the last event")
  check(finish.finishReason === reason, `expected finishReason "${reason}", got "${finish.finishReason}"`)
  check(finish.usage.inputTokens + (finish.usage.cacheReadTokens ?? 0) > 0, "usage must count input tokens")
  check(finish.usage.outputTokens > 0, "usage must count output tokens")
  const open = new Set<string>()
  for (const e of events) {
    if (e.type === "text-delta") open.add(e.id)
    if (e.type === "text-end") open.delete(e.id)
  }
  check(open.size === 0, `text parts left open: ${[...open].join(", ")}`)
}

const textOf = (events: ModelEvent[]) => events.map((e) => (e.type === "text-delta" ? e.delta : "")).join("")

export function driverContract(make: (scenario: DriverScenario) => ModelDriver): DriverContractCase[] {
  return [
    {
      name: "streams text and finishes with usage",
      scenario: "text",
      async run() {
        const events = await drain(make("text"), request({ messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: pong" }] }] }))
        checkCompleted(events, "stop")
        check(/pong/i.test(textOf(events)), `expected "pong", got "${textOf(events)}"`)
      },
    },
    {
      name: "streams a tool call with an object input",
      scenario: "tool-call",
      async run() {
        const events = await drain(
          make("tool-call"),
          request({
            tools: [CONTRACT_TOOL],
            messages: [{ role: "user", content: [{ type: "text", text: "What's the weather in Oslo? Use the get_weather tool." }] }],
          }),
        )
        checkCompleted(events, "tool-calls")
        const call = events.find((e) => e.type === "tool-call")
        check(call, "expected a tool-call event")
        check(call.toolName === "get_weather", `expected get_weather, got ${call.toolName}`)
        const input = call.input as { city?: unknown }
        check(input && typeof input === "object" && typeof input.city === "string", `tool input must be an object with a city: ${JSON.stringify(call.input)}`)
        const startAt = events.findIndex((e) => e.type === "tool-input-start" && e.toolCallId === call.toolCallId)
        check(startAt >= 0 && startAt < events.indexOf(call), "tool-input-start must come before its tool-call")
      },
    },
    {
      name: "continues after a tool result",
      scenario: "tool-result",
      async run() {
        const events = await drain(
          make("tool-result"),
          request({
            tools: [CONTRACT_TOOL],
            messages: [
              { role: "user", content: [{ type: "text", text: "What's the weather in Oslo? Use the get_weather tool." }] },
              { role: "assistant", content: [{ type: "tool-call", toolCallId: "toolu_contract_1", toolName: "get_weather", input: { city: "Oslo" } }] },
              { role: "tool", content: [{ type: "tool-result", toolCallId: "toolu_contract_1", toolName: "get_weather", output: { type: "json", value: { tempC: 4 } } }] },
            ],
          }),
        )
        checkCompleted(events, "stop")
        check(/4/.test(textOf(events)), `expected the answer to use the tool result, got "${textOf(events)}"`)
      },
    },
    {
      name: "stops quietly when aborted",
      scenario: "abort",
      async run() {
        const controller = new AbortController()
        const req = request(
          { messages: [{ role: "user", content: [{ type: "text", text: "Count from 1 to 200, one number per line." }] }], settings: { maxOutputTokens: 2000 } },
          controller.signal,
        )
        let threw: unknown
        let events: ModelEvent[] = []
        try {
          events = await drain(make("abort"), req, (e) => {
            if (e.type === "text-delta") controller.abort()
          })
        } catch (e) {
          threw = e
        }
        check(!threw, `abort must not throw: ${String(threw)}`)
        check(!events.some((e) => e.type === "error"), "abort must not yield an error event")
        check(events.some((e) => e.type === "text-delta"), "expected text before the abort")
      },
    },
    {
      name: "reports a failed call",
      scenario: "error",
      async run() {
        let failure: unknown
        try {
          const events = await drain(make("error"), request({ messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }] }))
          failure = events.find((e) => e.type === "error")?.error
          check(!events.some((e) => e.type === "finish"), "a failed call must not finish normally")
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Driver contract:")) throw e
          failure = e
        }
        check(failure, "expected an error event or a thrown error")
      },
    },
  ]
}
