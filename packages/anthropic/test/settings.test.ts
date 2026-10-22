import { createKit, defineAgent } from "@alexandernygard/ai-kit"
import { describe, expect, it } from "vitest"
import { claudeFromSettings, type ClaudeSettings } from "../src/index"

/** A fetch that answers every Messages request with a short streamed reply, and records it. */
function fakeFetch(reply: string) {
  const requests: Array<{ headers: Headers; body: any }> = []
  const events = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "x", usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ]
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")
    return new Response(sse, { headers: { "content-type": "text/event-stream" } })
  }
  return { fetch: fetch as typeof globalThis.fetch, requests }
}

describe("claudeFromSettings", () => {
  it("reads the key, model and effort on every call", async () => {
    const { fetch, requests } = fakeFetch("Hi.")
    let settings: ClaudeSettings = { model: "claude-haiku-5-5" }
    const driver = claudeFromSettings(() => settings, { clientOptions: { fetch, maxRetries: 0 } })
    const kit = createKit({ agents: [defineAgent({ name: "a", model: driver, settings: { effort: "low" } })] })
    const session = await kit.createSession()

    const noKey = await session.send("Hello").result
    expect(noKey.finishReason).toBe("error")
    expect(noKey.error?.message).toContain("API key")
    expect(requests).toHaveLength(0)

    settings = { apiKey: "sk-one", model: "claude-haiku-5-5" }
    expect((await session.send("Hello").result).text).toBe("Hi.")
    settings = { apiKey: "sk-two", model: "claude-opus-5-5", effort: "high" }
    expect(driver.modelId).toBe("claude-opus-5-5")
    expect(driver.capabilities?.forcedToolChoice).toBe(false)
    await session.send("Again").result

    expect(requests.map((r) => [r.headers.get("x-api-key"), r.body.model, r.body.output_config?.effort])).toEqual([
      ["sk-one", "claude-haiku-5-5", "low"],
      ["sk-two", "claude-opus-5-5", "high"],
    ])
    expect(requests[0]!.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true")
  })
})
