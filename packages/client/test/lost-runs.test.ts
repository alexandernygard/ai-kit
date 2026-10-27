import type { EventEnvelope, Message, SessionDetail, SessionInfo, ToolPart } from "@alexandernygard/ai-kit"
import { describe, expect, it } from "vitest"
import { Chat, isToolActive, type Transport } from "../src/index"

const session = (activeRunId: string | null): SessionInfo =>
  ({ id: "ses_1", agent: "a", headId: "msg_a", state: {}, activeRunId, createdAt: 0, updatedAt: 0 }) as SessionInfo

const user: Message = { id: "msg_u", role: "user", parentId: null, createdAt: 0, parts: [{ type: "text", id: "t0", text: "Chart my repos" }] }
const assistant: Message = { id: "msg_a", role: "assistant", parentId: "msg_u", createdAt: 0, parts: [], status: "streaming" }
const tool = (state: ToolPart["state"], error?: string): ToolPart => ({ type: "tool", toolCallId: "c1", toolName: "chart", runtime: "server", input: {}, state, error })

async function* events(list: EventEnvelope["event"][]): AsyncGenerator<EventEnvelope> {
  let seq = 0
  for (const event of list) yield { seq: seq++, runId: "run_1", event }
}

/** A server whose run dies mid-tool-call: its stream closes early and, after a while, the session is recovered. */
function dyingServer(opts: { recoverAfter: number }) {
  let loads = 0
  const transport = {
    createSession: async () => session(null),
    send: async () => ({
      runId: "run_1",
      events: events([
        { type: "run-start", runId: "run_1", sessionId: "ses_1", agent: "a", userMessage: user, message: assistant },
        { type: "tool-call", toolCallId: "c1", toolName: "chart", input: {}, runtime: "server" },
        { type: "tool-start", toolCallId: "c1" },
      ]),
    }),
    events: async () => ({ runId: "run_1", events: events([]) }),
    getSession: async (): Promise<SessionDetail> => {
      loads++
      if (loads <= opts.recoverAfter) return { session: session("run_1"), messages: [user, { ...assistant, parts: [tool("running")] }] }
      return { session: session(null), messages: [user, { ...assistant, status: "aborted", parts: [tool("output-error", "Interrupted.")] }] }
    },
  } as unknown as Transport
  return { transport, loads: () => loads }
}

describe("runs that die", () => {
  it("doesn't leave a tool spinning when the stream closes before run-finish", async () => {
    const server = dyingServer({ recoverAfter: 1 })
    const chat = new Chat({ transport: server.transport, reconnectAttempts: 1, lostRunTimeoutMs: 5000 })
    await chat.send("Chart my repos")
    const s = chat.getSnapshot()
    expect(server.loads()).toBe(2)
    expect(s.status).toBe("error")
    expect(s.error).toMatch(/stopped before it finished/)
    const last = s.path.at(-1)!
    expect(last.status).toBe("aborted")
    expect(last.parts[0]).toMatchObject({ state: "output-error", error: "Interrupted." })
  })

  it("gives up with an error when the run never clears", async () => {
    const server = dyingServer({ recoverAfter: Infinity })
    const chat = new Chat({ transport: server.transport, reconnectAttempts: 0, lostRunTimeoutMs: 10 })
    await chat.send("Chart my repos")
    expect(chat.getSnapshot().status).toBe("error")
  })
})

describe("isToolActive", () => {
  it("is false once the message stopped streaming", () => {
    expect(isToolActive(tool("running"))).toBe(true)
    expect(isToolActive(tool("running"), assistant)).toBe(true)
    expect(isToolActive(tool("running"), { ...assistant, status: "aborted" })).toBe(false)
    expect(isToolActive(tool("output-available"), assistant)).toBe(false)
  })
})
