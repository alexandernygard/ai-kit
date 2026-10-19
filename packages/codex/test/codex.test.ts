import { createKit, defineAgent, jsonSchema, tool, type ToolPart } from "@alexandernygard/ai-kit"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk"
import { describe, expect, it } from "vitest"
import { codex } from "../src/index"

const lookup = tool({
  name: "lookup_order",
  description: "Find an order",
  input: jsonSchema<{ id: string }>({ type: "object", properties: { id: { type: "string" } }, required: ["id"] }),
  execute: ({ id }) => ({ id, status: "shipped" }),
})

function fakeCodex(calls: Array<{ options: CodexOptions; thread: ThreadOptions; resume?: string; input: unknown }>) {
  return (options: CodexOptions) => {
    const thread = (threadOpts: ThreadOptions, resume?: string) => ({
      async runStreamed(input: unknown) {
        calls.push({ options, thread: threadOpts, resume, input })
        const bridge = (options.config!.mcp_servers as any).ai_kit
        async function* events(): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: resume ?? "thr_1" }
          yield { type: "turn.started" }
          yield { type: "item.started", item: { id: "r1", type: "reasoning", text: "Look it" } }
          yield { type: "item.completed", item: { id: "r1", type: "reasoning", text: "Look it up." } }
          // Codex calls the ai-kit tool over the real HTTP bridge.
          const client = new Client({ name: "codex", version: "1" })
          await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: bridge.http_headers } }))
          const res = await client.callTool({ name: "lookup_order", arguments: { id: "A1" } })
          await client.close()
          yield { type: "item.started", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" } }
          yield { type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" } }
          yield { type: "item.updated", item: { id: "m1", type: "agent_message", text: "Order " } }
          yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: `Order ${(res.content as any)[0].text}` } }
          yield { type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 } }
        }
        return { events: events() }
      },
    })
    return { startThread: (t?: ThreadOptions) => thread(t ?? {}) as never, resumeThread: (id: string, t?: ThreadOptions) => thread(t ?? {}, id) as never }
  }
}

describe("codex", () => {
  it("bridges tools over local MCP and maps items", async () => {
    const calls: Parameters<Parameters<typeof fakeCodex>[0]["push"]>[0][] = []
    const kit = createKit({
      agents: [defineAgent({ name: "a", instructions: "Help with orders.", model: codex({ createClient: fakeCodex(calls) }), tools: [lookup] })],
    })
    const s = await kit.createSession()
    const r = await s.send("Where is A1?").result
    expect(r.finishReason).toBe("stop")
    expect(r.text).toBe('Order {"id":"A1","status":"shipped"}')
    expect(r.usage).toMatchObject({ inputTokens: 50, outputTokens: 20, cacheReadTokens: 10 })
    const tools = r.message.parts.filter((p): p is ToolPart => p.type === "tool")
    expect(tools.map((t) => [t.toolName, t.state])).toEqual([
      ["lookup_order", "output-available"],
      ["shell", "output-available"],
    ])
    expect(r.message.parts.find((p) => p.type === "reasoning")).toMatchObject({ text: "Look it up." })
    expect(calls[0]!.options.config!.developer_instructions).toBe("Help with orders.")
    expect(calls[0]!.thread.sandboxMode).toBe("read-only")

    await s.send("And A2?").result
    expect(calls[1]!.resume).toBe("thr_1")
  })

  it("rejects bridge calls without the token", async () => {
    let url = ""
    const kit = createKit({
      agents: [
        defineAgent({
          name: "a",
          model: codex({
            createClient: (options) => ({
              startThread: () =>
                ({
                  async runStreamed() {
                    url = (options.config!.mcp_servers as any).ai_kit.url
                    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
                    async function* events(): AsyncGenerator<ThreadEvent> {
                      yield { type: "item.completed", item: { id: "m", type: "agent_message", text: String(res.status) } }
                    }
                    return { events: events() }
                  },
                }) as never,
              resumeThread: () => ({}) as never,
            }),
          }),
          tools: [lookup],
        }),
      ],
    })
    const r = await (await kit.createSession()).send("x").result
    expect(r.text).toBe("401")
    await expect(fetch(url)).rejects.toThrow()
  })
})
