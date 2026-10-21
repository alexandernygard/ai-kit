import { createKit, defineAgent, jsonSchema, tool, type ToolPart } from "@alexandernygard/ai-kit"
import { describe, expect, it } from "vitest"
import { claude } from "../src/index"

type Event = Record<string, any>

/** A stand-in for `client.beta.messages.create`: each call streams the next script. */
function mockClient(scripts: Array<Event[] | (() => never)>) {
  const calls: any[] = []
  const client = {
    beta: {
      messages: {
        create: async (params: any) => {
          calls.push(structuredClone(params))
          const script = scripts[calls.length - 1]
          if (!script) throw new Error("no more scripts")
          if (typeof script === "function") script()
          return (async function* () {
            yield* script as Event[]
          })()
        },
      },
    },
  }
  return { client: client as any, calls }
}

const start = (input = 10, cacheRead = 0) => ({
  type: "message_start",
  message: { usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
})
const stop = (reason: string, output = 5) => [{ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: output } }, { type: "message_stop" }]
const block = (index: number, content_block: Event, ...deltas: Event[]) => [
  { type: "content_block_start", index, content_block },
  ...deltas.map((delta) => ({ type: "content_block_delta", index, delta })),
  { type: "content_block_stop", index },
]
const text = (index: number, ...chunks: string[]) => block(index, { type: "text", text: "" }, ...chunks.map((t) => ({ type: "text_delta", text: t })))

const weather = tool({
  name: "get_weather",
  description: "Weather",
  input: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  execute: ({ city }) => ({ city, tempC: 4 }),
})

describe("claude driver", () => {
  it("runs a tool loop and sends thinking back with its signature", async () => {
    const { client, calls } = mockClient([
      [
        start(10, 3),
        ...block(0, { type: "thinking", thinking: "", signature: "" }, { type: "thinking_delta", thinking: "Need weather." }, { type: "signature_delta", signature: "sig" }),
        ...block(
          1,
          { type: "tool_use", id: "c1", name: "get_weather", input: {} },
          { type: "input_json_delta", partial_json: '{"city":' },
          { type: "input_json_delta", partial_json: '"Oslo"}' },
        ),
        ...stop("tool_use"),
      ],
      [start(20, 3), ...text(0, "It's ", "4C."), ...stop("end_turn", 3)],
    ])
    const kit = createKit({ agents: [defineAgent({ name: "a", model: claude("claude-opus-5-5", { client }), instructions: "Be brief.", tools: [weather] })] })
    const r = await (await kit.createSession()).send("Weather in Oslo?").result

    expect(r.text).toBe("It's 4C.")
    expect(r.usage).toMatchObject({ inputTokens: 30, outputTokens: 8, cacheReadTokens: 6 })
    expect(r.usage.costUsd).toBeGreaterThan(0)
    const part = r.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part.output).toEqual({ city: "Oslo", tempC: 4 })
    expect(r.message.parts.find((p) => p.type === "reasoning")).toMatchObject({ text: "Need weather.", providerMetadata: { anthropic: { signature: "sig" } } })

    const first = calls[0]
    expect(first).toMatchObject({ model: "claude-opus-5-5", stream: true, max_tokens: 64000 })
    expect(first.system[0]).toMatchObject({ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } })
    expect(first.tools[0]).toMatchObject({ name: "get_weather", eager_input_streaming: true, input_schema: { type: "object" } })
    expect(first.thinking).toBeUndefined()

    const [, assistant, results] = calls[1].messages
    expect(assistant).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need weather.", signature: "sig" },
        { type: "tool_use", id: "c1", name: "get_weather", input: { city: "Oslo" } },
      ],
    })
    expect(results.role).toBe("user")
    expect(results.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1", content: '{"city":"Oslo","tempC":4}', cache_control: { type: "ephemeral" } })
  })

  it("rejects tool input that isn't valid JSON instead of running the tool", async () => {
    let ran = false
    const t = tool({ ...weather, execute: ({ city }) => ((ran = true), { city, tempC: 4 }) })
    const { client, calls } = mockClient([
      [start(), ...block(0, { type: "tool_use", id: "c1", name: "get_weather", input: {} }, { type: "input_json_delta", partial_json: '{"city": "Os' }), ...stop("tool_use")],
      [start(), ...text(0, "Sorry."), ...stop("end_turn")],
    ])
    const kit = createKit({ agents: [defineAgent({ name: "a", model: claude("claude-opus-5-5", { client }), tools: [t] })] })
    const r = await (await kit.createSession()).send("Weather?").result
    expect(ran).toBe(false)
    expect(r.message.parts.find((p): p is ToolPart => p.type === "tool")!.state).toBe("output-error")
    expect(calls[1].messages[1].content[0]).toMatchObject({ type: "tool_use", input: {} })
    expect(calls[1].messages[2].content[0]).toMatchObject({ type: "tool_result", is_error: true })
  })

  it("passes server tools through and sends their result blocks back unchanged", async () => {
    const result = { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://yr.no", title: "Yr", encrypted_content: "enc" }] }
    const { client, calls } = mockClient([
      [
        start(),
        ...block(0, { type: "server_tool_use", id: "s1", name: "web_search", input: {} }, { type: "input_json_delta", partial_json: '{"query":"oslo weather"}' }),
        { type: "content_block_start", index: 1, content_block: result },
        { type: "content_block_stop", index: 1 },
        ...block(
          2,
          { type: "text", text: "" },
          { type: "text_delta", text: "Rainy." },
          { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://yr.no", title: "Yr", cited_text: "rain" } },
        ),
        ...stop("end_turn"),
      ],
      [start(), ...text(0, "Still rainy."), ...stop("end_turn")],
    ])
    const search = tool({ name: "web_search", description: "Search the web", provider: { type: "web_search_20260209", max_uses: 3 } })
    const kit = createKit({ agents: [defineAgent({ name: "a", model: claude("claude-opus-5-5", { client }), tools: [search] })] })
    const session = await kit.createSession()
    const r = await session.send("Weather in Oslo?").result

    expect(calls[0].tools[0]).toEqual({ name: "web_search", type: "web_search_20260209", max_uses: 3 })
    const part = r.message.parts.find((p): p is ToolPart => p.type === "tool")!
    expect(part).toMatchObject({ runtime: "provider", toolName: "web_search", input: { query: "oslo weather" }, state: "output-available" })
    expect(r.message.parts.find((p) => p.type === "source")).toMatchObject({ url: "https://yr.no", title: "Yr" })

    await session.send("And now?").result
    expect(calls[1].messages[1].content).toEqual([
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "oslo weather" } },
      result,
      { type: "text", text: "Rainy." },
    ])
  })

  it("resumes a paused turn within the same step", async () => {
    const { client, calls } = mockClient([
      [start(), ...text(0, "Searching... "), ...stop("pause_turn")],
      [start(), ...text(0, "done."), ...stop("end_turn")],
    ])
    const kit = createKit({ agents: [defineAgent({ name: "a", model: claude("claude-opus-5-5", { client }) })] })
    const r = await (await kit.createSession()).send("Go").result
    expect(r.text).toBe("Searching... done.")
    expect(r.usage.inputTokens).toBe(20)
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Searching... " }] })
  })

  it("maps settings, structured output and errors", async () => {
    const { client, calls } = mockClient([
      () => {
        throw new Error("401 invalid x-api-key")
      },
    ])
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model: claude("claude-sonnet-5-5", { client, cache: false, fallbacks: "default" }),
          settings: { effort: "minimal", reasoningSummary: true, maxOutputTokens: 1000 },
          output: jsonSchema<{ answer: string }>({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }),
        }),
      ],
    })
    const r = await (await kit.createSession()).send("hi").result
    expect(r.finishReason).toBe("error")
    expect(r.error?.message).toContain("401")
    expect(calls[0]).toMatchObject({
      max_tokens: 1000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object" } } },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    })
    expect(JSON.stringify(calls[0])).not.toContain("cache_control")
  })
})
