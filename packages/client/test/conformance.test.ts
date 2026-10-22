import { type AgentEvent, createKit, defineAgent, jsonSchema, tool } from "@alexandernygard/ai-kit"
import { createHandler } from "@alexandernygard/ai-kit-server"
import { collect, mockModel } from "@alexandernygard/ai-kit/testing"
import { describe, expect, it } from "vitest"
import { Chat, directTransport, httpTransport, type Transport } from "../src/index"

/*
 * One agent, three deployment shapes: the kit called directly, a Chat over HTTP through
 * `createHandler`, and a Chat on `directTransport`. Each must see the same events.
 */

const weather = tool({
  name: "get_weather",
  description: "Weather",
  input: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
  readOnly: true,
  execute: ({ city }) => ({ city, tempC: 4 }),
})
const remove = tool({
  name: "delete_file",
  description: "Delete a file",
  input: jsonSchema<{ path: string }>({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
  needsApproval: true,
  execute: ({ path }) => `deleted ${path}`,
})

const makeKit = () =>
  createKit({
    agents: [
      defineAgent({
        name: "a",
        tools: [weather, remove],
        model: mockModel([
          { reasoning: "Need weather.", toolCalls: [{ name: "get_weather", input: { city: "Oslo" }, id: "c1" }] },
          { text: "It's 4 degrees in Oslo." },
          { toolCalls: [{ name: "delete_file", input: { path: "a.txt" }, id: "c2" }] },
          { text: "Deleted a.txt." },
        ]),
      }),
    ],
  })

const TIME_KEYS = new Set(["createdAt", "updatedAt", "startedAt", "endedAt", "durationMs"])
const ID = /^[a-z]+_[0-9A-Za-z]{6,}$/

/** Random ids become `<id N>` by first appearance; timestamps become 0. */
function normalize(events: AgentEvent[]) {
  const ids = new Map<string, string>()
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "number" && key && TIME_KEYS.has(key)) return 0
    if (typeof v === "string" && ID.test(v)) {
      if (!ids.has(v)) ids.set(v, `<id ${ids.size}>`)
      return ids.get(v)
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  return events.map((e) => walk(e))
}

async function viaKit() {
  const session = await makeKit().createSession({ agent: "a" })
  const events = await collect(session.send("Weather in Oslo?"))
  events.push(...(await collect(session.send("Delete a.txt"))))
  events.push(...(await collect(session.resume({ c2: { approved: true } }))))
  return events
}

async function viaChat(transport: Transport) {
  const events: AgentEvent[] = []
  const chat = new Chat({ transport, newSession: { agent: "a" }, onEvent: (e) => events.push(e) })
  await chat.send("Weather in Oslo?")
  await chat.send("Delete a.txt")
  await chat.approve("c2")
  return events
}

describe("deployment shapes", () => {
  it("emit the same events directly, over HTTP and in-process", async () => {
    const http = createHandler(makeKit())
    const [direct, overHttp, inProcess] = await Promise.all([
      viaKit(),
      viaChat(httpTransport({ baseUrl: "http://app.test/api/ai", fetch: (input, init) => http(new Request(input as string, init)) })),
      viaChat(directTransport(makeKit())),
    ])
    expect(direct.map((e) => e.type)).toContain("tool-approval-request")
    expect(normalize(overHttp)).toEqual(normalize(direct))
    expect(normalize(inProcess)).toEqual(normalize(direct))
  })
})
