import { clientContext, createKit, defineAgent, jsonSchema, type Kit, textOf, tool } from "@alexandernygard/ai-kit"
import { createHandler } from "@alexandernygard/ai-kit-server"
import { mockModel, type MockResponse } from "@alexandernygard/ai-kit/testing"
import { describe, expect, it } from "vitest"
import { Chat, type ChatState, directTransport, httpTransport, segments } from "../src/index"

const deleteFile = tool({
  name: "delete_file",
  description: "Delete",
  input: jsonSchema<{ path: string }>({ type: "object", properties: { path: { type: "string" } } }),
  needsApproval: true,
  execute: ({ path }) => `deleted ${path}`,
})
const location = tool({ name: "get_location", description: "The user's location, from the browser" })

function setup(responses: MockResponse[], opts: { user?: string } = {}) {
  const model = mockModel(responses)
  const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: [deleteFile, location] })] })
  const handler = createHandler(kit, { auth: (req) => ({ userId: req.headers.get("x-user") ?? opts.user ?? "ann" }) })
  const transport = (user = opts.user ?? "ann") =>
    httpTransport({ baseUrl: "http://app.test/api/ai", headers: { "x-user": user }, fetch: (input, init) => handler(new Request(input as string, init)) })
  return { model, kit, handler, transport }
}

function track(chat: Chat) {
  const statuses: ChatState["status"][] = []
  chat.subscribe((s) => {
    if (statuses.at(-1) !== s.status) statuses.push(s.status)
  })
  return statuses
}

describe("Chat over HTTP", () => {
  it("creates a session on first send and streams the answer", async () => {
    const { transport } = setup([{ text: "Hello from the agent" }])
    const created: string[] = []
    const chat = new Chat({ transport: transport(), newSession: { agent: "a" }, onSessionCreated: (s) => created.push(s.id) })
    const statuses = track(chat)
    await chat.send("Hi")
    const s = chat.getSnapshot()
    expect(statuses).toEqual(["idle", "submitted", "streaming", "idle"])
    expect(s.path.map(textOf)).toEqual(["Hi", "Hello from the agent"])
    expect(s.path[0]!.id.startsWith("optimistic")).toBe(false)
    expect(created).toEqual([s.sessionId])
    expect(s.session?.title).toBe("Hi")

    const reopened = new Chat({ transport: transport(), sessionId: s.sessionId! })
    await reopened.ready
    expect(reopened.getSnapshot().path.map(textOf)).toEqual(["Hi", "Hello from the agent"])
  })

  it("batches approvals and resumes once", async () => {
    const { transport, model } = setup([
      { toolCalls: [{ name: "delete_file", input: { path: "a" }, id: "c1" }, { name: "delete_file", input: { path: "b" }, id: "c2" }] },
      { text: "Deleted both." },
    ])
    const chat = new Chat({ transport: transport() })
    await chat.send("delete a and b")
    expect(chat.getSnapshot().status).toBe("awaiting-input")
    expect(chat.getSnapshot().pending.map((p) => p.toolCallId)).toEqual(["c1", "c2"])
    await chat.approve("c1")
    expect(model.requests.length).toBe(1)
    await chat.deny("c2", "not b")
    const s = chat.getSnapshot()
    expect(s.status).toBe("idle")
    expect(textOf(s.path.at(-1))).toContain("Deleted both.")
    const tools = segments(s.path.at(-1)!).find((x) => x.kind === "tools")
    expect(tools && tools.kind === "tools" && tools.tools.map((t) => t.state)).toEqual(["output-available", "denied"])
  })

  it("runs client tools in the browser", async () => {
    const { transport } = setup([{ toolCalls: [{ name: "get_location", input: {} }] }, { text: "You're in Oslo." }])
    const chat = new Chat({ transport: transport(), clientTools: { get_location: async () => ({ city: "Oslo" }) } })
    await chat.send("Where am I?")
    await chat.ready
    // The tool ran and the chat resumed by itself.
    await new Promise((r) => setTimeout(r, 20))
    const s = chat.getSnapshot()
    expect(textOf(s.path.at(-1))).toBe("You're in Oslo.")
    expect(s.status).toBe("idle")
  })

  it("regenerates, edits and switches versions", async () => {
    const { transport } = setup([{ text: "v1" }, { text: "v2" }, { text: "edited answer" }])
    const chat = new Chat({ transport: transport() })
    await chat.send("Q")
    await chat.regenerate()
    let s = chat.getSnapshot()
    const answer = s.path.at(-1)!
    expect(textOf(answer)).toBe("v2")
    expect(chat.versions(answer.id)).toMatchObject({ index: 1, total: 2 })
    await chat.switchBranch(chat.versions(answer.id).previous!)
    expect(textOf(chat.getSnapshot().path.at(-1))).toBe("v1")
    await chat.edit(chat.getSnapshot().path[0]!.id, "Q2")
    s = chat.getSnapshot()
    expect(s.path.map(textOf)).toEqual(["Q2", "edited answer"])
    const forkId = await chat.fork()
    expect(forkId).not.toBe(s.sessionId)
    expect(chat.getSnapshot().path.map(textOf)).toEqual(["Q2", "edited answer"])
  })

  it("scopes sessions to their owner", async () => {
    const { transport } = setup([{ text: "secret" }])
    const ann = new Chat({ transport: transport("ann") })
    await ann.send("hi")
    const bob = transport("bob")
    await expect(bob.getSession(ann.getSnapshot().sessionId!)).rejects.toThrow(/not found/i)
    expect((await bob.listSessions()).sessions).toEqual([])
    expect((await transport("ann").listSessions()).sessions.length).toBe(1)
  })

  it("replays a finished run's events from a seq", async () => {
    const { transport } = setup([{ text: "abcdefghijklmnop" }])
    const t = transport()
    let runId = ""
    const chat = new Chat({ transport: t, onEvent: (e) => void (e.type === "run-start" && (runId = e.runId)) })
    await chat.send("go")
    const replay = await t.events(runId, { sessionId: chat.getSnapshot().sessionId!, after: 2 })
    const seqs: number[] = []
    for await (const env of replay.events) seqs.push(env.seq)
    expect(seqs[0]).toBe(3)
    expect(seqs.length).toBeGreaterThan(3)
  })

  it("sends client context with every message and exposes context usage", async () => {
    const model = mockModel([{ text: "You're on the orders page." }, { text: "again" }], { capabilities: { contextWindow: 10_000 } })
    const kit = createKit({ agents: [defineAgent({ name: "a", model, contextProviders: [clientContext()] })] })
    const handler = createHandler(kit, { clientContext: { maxBytes: 200 } })
    const transport = httpTransport({ baseUrl: "http://app.test/api/ai", fetch: (input, init) => handler(new Request(input as string, init)) })
    let route = "/orders"
    const chat = new Chat({ transport, getContext: () => ({ route }) })
    await chat.send("Where am I?", { context: { selection: "A1" } })
    expect(JSON.stringify(model.requests[0]!.messages)).toContain('\\"route\\": \\"/orders\\"')
    expect(JSON.stringify(model.requests[0]!.messages)).toContain("A1")
    const usage = chat.getSnapshot().contextUsage!
    expect(usage.window).toBe(10_000)
    expect(usage.source).toBe("provider")

    route = "/settings"
    await chat.regenerate()
    expect(JSON.stringify(model.requests[1]!.messages)).toContain("/settings")

    await chat.send("x".repeat(10), { context: { big: "z".repeat(500) } })
    expect(chat.getSnapshot().error).toMatch(/larger than 200 bytes/)
  })

  it("answers live runs (code mode waits in memory)", async () => {
    const code = "return await tools.delete_file({ path: 'a' })"
    const model = mockModel([{ toolCalls: [{ name: "run_code", input: { code }, id: "rc" }] }, { text: "done" }])
    const kit: Kit = createKit({ agents: [defineAgent({ name: "h", model, tools: [deleteFile], codeMode: true })] })
    const modes: string[] = []
    const chat = new Chat({
      transport: directTransport(kit),
      onEvent: (e) => {
        if (e.type === "tool-approval-request") {
          modes.push(e.mode)
          void chat.approve(e.toolCallId)
        }
      },
    })
    await chat.send("delete a")
    expect(modes).toEqual(["wait"])
    expect(textOf(chat.getSnapshot().path.at(-1))).toBe("done")
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("deleted a")
  })
})
