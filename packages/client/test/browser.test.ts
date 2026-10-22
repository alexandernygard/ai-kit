import "fake-indexeddb/auto"
import { defineAgent, kvStore, textOf } from "@alexandernygard/ai-kit"
import { mockModel } from "@alexandernygard/ai-kit/testing"
import { describe, expect, it } from "vitest"
import { Chat, createBrowserKit, findDocumentSession, indexedDBKV, settingsStore } from "../src/index"

describe("browser-only apps", () => {
  it("stores sessions in IndexedDB that survive a new kit", async () => {
    const database = `test-${Math.random()}`
    const agents = [defineAgent({ name: "a", model: mockModel([{ text: "Hi there." }]) })]
    const first = createBrowserKit({ agents, database })
    const chat = new Chat({ transport: first.transport, newSession: { agent: "a", metadata: { documentId: "doc-1" } } })
    await chat.send("Hello")

    // A reload: a new kit on the same database finds the document's conversation.
    const second = createBrowserKit({ agents, database })
    const found = await findDocumentSession(second.transport, "doc-1")
    expect(found?.id).toBe(chat.getSnapshot().sessionId)
    expect(await findDocumentSession(second.transport, "doc-2")).toBeUndefined()
    const reopened = new Chat({ transport: second.transport, sessionId: found!.id })
    await reopened.ready
    expect(reopened.getSnapshot().path.map(textOf)).toEqual(["Hello", "Hi there."])
  })

  it("indexedDBKV lists keys by prefix", async () => {
    const kv = indexedDBKV({ database: `kv-${Math.random()}` })
    await kv.set("a:1", "x")
    await kv.set("a:2", "y")
    await kv.set("b:1", "z")
    expect((await kv.list("a:")).sort()).toEqual(["a:1", "a:2"])
    await kv.delete("a:1")
    expect(await kv.get("a:1")).toBeUndefined()
    expect(await kv.get("a:2")).toBe("y")
    // Works as a Store.
    expect((await kvStore(kv).listSessions({})).sessions).toEqual([])
  })

  it("settingsStore persists, merges defaults and notifies", () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    const a = settingsStore({ model: "claude-opus-5-5", apiKey: undefined as string | undefined }, { storage })
    const seen: string[] = []
    a.subscribe((s) => seen.push(s.model))
    a.set({ apiKey: "sk-test", model: "claude-sonnet-5-5" })
    expect(seen).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"])
    const b = settingsStore({ model: "claude-opus-5-5", apiKey: undefined as string | undefined, effort: "high" }, { storage })
    expect(b.get()).toEqual({ model: "claude-sonnet-5-5", apiKey: "sk-test", effort: "high" })
  })
})
