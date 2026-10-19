import { createKit, defineAgent, jsonSchema, tool, type ToolPart } from "@alexandernygard/ai-kit"
import { mockModel } from "@alexandernygard/ai-kit/testing"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { describe, expect, it } from "vitest"
import { connectMcp, createMcpServer, mcpHttpHandler, mcpPlugin } from "../src/index"

const add = tool({
  name: "add",
  description: "Add two numbers",
  input: jsonSchema<{ a: number; b: number }>({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }),
  readOnly: true,
  execute: ({ a, b }) => ({ sum: a + b }),
})

function inProcessTransport() {
  const handler = mcpHttpHandler(() => createMcpServer([add], { name: "calc", instructions: "Math tools." }))
  return new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
    fetch: (input, init) => handler(new Request(input as string, init)),
  })
}

describe("mcp", () => {
  it("serves kit tools and reads them back as a toolkit", async () => {
    const conn = await connectMcp({ name: "calc", transport: { transport: inProcessTransport() } })
    expect(conn.toolkit.defer).toBe(true)
    expect(conn.toolkit.instructions).toBe("Math tools.")
    const t = conn.toolkit.tools[0]!
    expect(t.name).toBe("mcp__calc__add")
    expect(t.needsApproval).toBe(true)
    const out = await t.execute!({ a: 2, b: 3 }, { signal: new AbortController().signal } as never)
    expect(out).toEqual({ type: "text", value: '{"sum":5}' })
    await conn.close()
  })

  it("plugs MCP tools into an agent with tool search", async () => {
    const plugin = mcpPlugin([{ name: "calc", transport: { transport: inProcessTransport() }, needsApproval: false }])
    const model = mockModel([
      { toolCalls: [{ name: "search_tools", input: { toolkit: "calc" } }] },
      { toolCalls: [{ name: "mcp__calc__add", input: { a: 1, b: 41 } }] },
      { text: "42" },
    ])
    const kit = createKit({ agents: [defineAgent({ name: "a", model })], plugins: [plugin] })
    const r = await (await kit.createSession()).send("1+41?").result
    expect(r.text).toBe("42")
    const call = r.message.parts.filter((p): p is ToolPart => p.type === "tool").at(-1)!
    expect(call.state).toBe("output-available")
    expect(JSON.stringify(model.requests[2]!.messages)).toContain('{\\"sum\\":42}')
    await plugin.close()
  })
})
