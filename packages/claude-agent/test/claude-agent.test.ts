import { createKit, defineAgent, jsonSchema, tool, type ToolPart } from "@alexandernygard/ai-kit"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { describe, expect, it } from "vitest"
import { claudeAgent, type ClaudeQuery } from "../src/index"

const weather = tool({
  name: "get_weather",
  description: "Weather",
  input: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  execute: ({ city }) => `4C in ${city}`,
})

const ev = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "u", session_id: "s" })

/** A fake `query` that plays a Claude Code turn and calls the bridged MCP server for real. */
function fakeQuery(seen: Options[]): ClaudeQuery {
  return ({ options }) => {
    seen.push(options!)
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: options!.resume ? "sess-2" : "sess-1" }
      yield ev({ type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50 } } })
      yield ev({ type: "content_block_start", index: 0, content_block: { type: "text" } })
      yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } })
      yield ev({ type: "content_block_stop", index: 0 })
      yield ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__ai_kit__get_weather" } })
      yield ev({ type: "content_block_stop", index: 1 })
      yield ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "Bash" } })
      yield ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } })
      yield ev({ type: "content_block_stop", index: 2 })
      yield ev({ type: "message_delta", usage: { output_tokens: 30 } })
      yield ev({ type: "message_stop" })

      // Claude Code calls the bridged tool over MCP...
      const server = (options!.mcpServers!.ai_kit as { instance: any }).instance
      const [a, b] = InMemoryTransport.createLinkedPair()
      await server.connect(a)
      const client = new Client({ name: "t", version: "1" })
      await client.connect(b)
      const res = await client.callTool({ name: "get_weather", arguments: { city: "Oslo" } })
      // ...and asks permission for its own Bash tool.
      const perm = await options!.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "toolu_2" } as never)
      yield {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "text copy of the bridged result" }, { type: "tool_result", tool_use_id: "toolu_2", content: perm!.behavior === "allow" ? "a.txt" : "denied", is_error: perm!.behavior !== "allow" }] },
        parent_tool_use_id: null,
      }
      yield ev({ type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } })
      yield ev({ type: "content_block_start", index: 0, content_block: { type: "text" } })
      yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (res.content as any)[0].text } })
      yield ev({ type: "content_block_stop", index: 0 })
      yield ev({ type: "message_stop" })
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0.0123,
        usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
        structured_output: undefined,
      }
    })() as never
  }
}

describe("claudeAgent", () => {
  it("bridges tools, maps the stream and resumes", async () => {
    const seen: Options[] = []
    const agent = defineAgent({
      name: "a",
      instructions: "Be helpful.",
      model: claudeAgent({ model: "claude-opus-5-5", query: fakeQuery(seen) }),
      tools: [weather],
      permissions: { ask: ["Bash"] },
    })
    const kit = createKit({ agents: [agent] })
    const s = await kit.createSession()
    const run = s.send("Weather?")
    for await (const e of run) if (e.type === "tool-approval-request") run.respond(e.toolCallId, { approved: true, remember: true })
    const r = await run.result

    expect(r.finishReason).toBe("stop")
    expect(r.text).toBe("4C in Oslo")
    expect(r.usage).toMatchObject({ inputTokens: 120, outputTokens: 40, costUsd: 0.0123 })
    const tools = r.message.parts.filter((p): p is ToolPart => p.type === "tool")
    expect(tools.map((t) => [t.toolCallId, t.toolName, t.state, t.runtime])).toEqual([
      ["toolu_1", "get_weather", "output-available", "server"],
      ["toolu_2", "Bash", "output-available", "harness"],
    ])
    expect(tools[1]!.input).toEqual({ command: "ls" })
    expect(tools[0]!.output).toBe("4C in Oslo")
    expect(tools[1]!.approval?.approved).toBe(true)

    expect(seen[0]!.systemPrompt).toBe("Be helpful.")
    expect(seen[0]!.tools).toEqual([])
    expect(seen[0]!.settingSources).toEqual([])
    expect(Object.keys(seen[0]!.mcpServers!)).toEqual(["ai_kit"])

    await s.send("again").result
    expect(seen[1]!.resume).toBe("sess-1")
  })

  it("reports SDK errors", async () => {
    const query: ClaudeQuery = () =>
      (async function* () {
        yield { type: "result", subtype: "error_during_execution", errors: ["Not logged in"], usage: {}, total_cost_usd: 0 }
      })() as never
    const kit = createKit({ agents: [defineAgent({ name: "a", model: claudeAgent({ query }) })] })
    const r = await (await kit.createSession()).send("hi").result
    expect(r.finishReason).toBe("error")
    expect(r.error?.message).toBe("Not logged in")
  })
})
