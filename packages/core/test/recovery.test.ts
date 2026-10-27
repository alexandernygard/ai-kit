import { describe, expect, it } from "vitest"
import { createKit, defineAgent, memoryStore, type Message, type Store, tool, type ToolPart } from "../src/index"
import { mockModel } from "../src/testing"

const hang = tool({ name: "hang", description: "Never finishes", execute: () => new Promise(() => {}) })

const kitOn = (store: Store, runLeaseMs = 1000) =>
  createKit({ agents: [defineAgent({ name: "a", model: mockModel([{ toolCalls: [{ name: "hang", input: {}, id: "c1" }] }]), tools: [hang] })], store, runLeaseMs })

/** A session whose run died mid-tool-call: what a crashed process leaves in the store. */
async function orphan(store: Store, leaseUntil: number | null, tools: ToolPart[]) {
  const kit = kitOn(store)
  const session = await kit.createSession()
  const message: Message = {
    id: "msg_dead",
    role: "assistant",
    parentId: null,
    createdAt: Date.now(),
    status: "streaming",
    parts: [{ type: "text", id: "t1", text: "Charting", state: "streaming" }, ...tools],
  }
  await store.putMessage(session.id, message)
  await store.updateSession(session.id, { headId: message.id, activeRunId: "run_dead", activeRunLeaseUntil: leaseUntil })
  return session.id
}

const running: ToolPart = { type: "tool", toolCallId: "c1", toolName: "chart", state: "running", runtime: "server", input: {} }

describe("runs that die", () => {
  it("ends an orphaned run once its lease lapses", async () => {
    const store = memoryStore()
    const id = await orphan(store, Date.now() - 1, [running])
    const session = (await kitOn(store).getSession(id))!
    expect(session.record.activeRunId).toBeNull()
    const [message] = await session.messages()
    expect(message!.status).toBe("aborted")
    expect(message!.parts[0]).toMatchObject({ type: "text", state: "done" })
    expect(message!.parts[1]).toMatchObject({ state: "output-error", error: "Interrupted." })
  })

  it("keeps calls waiting on the user so the session can resume", async () => {
    const store = memoryStore()
    const waiting: ToolPart = { ...running, toolCallId: "c2", state: "awaiting-approval", approval: { mode: "wait" } }
    const id = await orphan(store, null, [running, waiting])
    const [message] = await (await kitOn(store).getSession(id))!.messages()
    expect(message!.status).toBe("awaiting-input")
    expect(message!.parts.map((p) => (p as ToolPart).state)).toEqual(["done", "output-error", "awaiting-approval"])
  })

  it("leaves a run alone while its lease is current", async () => {
    const store = memoryStore()
    const id = await orphan(store, Date.now() + 60_000, [running])
    const other = kitOn(store)
    const session = (await other.getSession(id))!
    expect(session.record.activeRunId).toBe("run_dead")
    expect((await session.messages())[0]!.status).toBe("streaming")
    await expect(session.send("again").result).resolves.toMatchObject({ finishReason: "error", error: { message: expect.stringContaining("another process") } })
  })

  it("renews the lease while the run is alive and clears it when it ends", async () => {
    const store = memoryStore()
    const owner = kitOn(store, 60)
    const session = await owner.createSession()
    const run = session.send("go")
    await new Promise((r) => setTimeout(r, 250))
    // Another process sees a live lease well past the first one's expiry.
    const seen = (await kitOn(store).getSession(session.id))!.record
    expect(seen.activeRunId).toBe(run.id)
    expect(seen.activeRunLeaseUntil).toBeGreaterThan(Date.now())

    run.abort()
    await run.result
    const done = (await store.getSession(session.id))!
    expect(done.activeRunId).toBeNull()
    expect(done.activeRunLeaseUntil).toBeNull()
  })

  it("lets the session take new messages after recovery", async () => {
    const store = memoryStore()
    const id = await orphan(store, Date.now() - 1, [running])
    const kit = createKit({ agents: [defineAgent({ name: "a", model: mockModel([{ text: "Back." }]) })], store })
    const result = await (await kit.getSession(id))!.send("still there?").result
    expect(result.finishReason).toBe("stop")
    expect(result.text).toBe("Back.")
  })
})
