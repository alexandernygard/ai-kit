import type { AgentEvent } from "./events"
import type { Message, Part, ToolPart } from "./messages"
import { now } from "./id"

export interface ReduceOptions {
  /**
   * Keep a live copy of each subagent's message on its tool part (`ToolPart.child`), so UIs can
   * show nested work. Servers leave this off: child sessions are stored on their own.
   */
  nestSubagents?: boolean
  /** How many progress values to keep per tool call. Default 5. */
  progressLimit?: number
}

/**
 * Apply one event to the assistant message it belongs to. Pure: returns a new message when
 * something changed, the same object otherwise. Used by the runner to build what it stores
 * and by clients to render.
 */
export function reduceMessage(message: Message, event: AgentEvent, options: ReduceOptions = {}): Message {
  switch (event.type) {
    case "run-start":
      return event.message
    case "step-start":
      return withParts(message, [...message.parts, { type: "step", index: event.step }])
    case "text-delta":
      return upsertPart(message, (p) => p.type === "text" && p.id === event.partId, (p) =>
        p && p.type === "text"
          ? { ...p, text: p.text + event.delta }
          : { type: "text", id: event.partId, text: event.delta, state: "streaming" },
      )
    case "text-end":
      return updatePart(message, (p) => p.type === "text" && p.id === event.partId, (p) => ({ ...p, state: "done" }) as Part)
    case "reasoning-delta":
      return upsertPart(message, (p) => p.type === "reasoning" && p.id === event.partId, (p) =>
        p && p.type === "reasoning"
          ? { ...p, text: p.text + event.delta, providerMetadata: event.providerMetadata ?? p.providerMetadata }
          : { type: "reasoning", id: event.partId, text: event.delta, state: "streaming", providerMetadata: event.providerMetadata },
      )
    case "reasoning-end":
      return updatePart(message, (p) => p.type === "reasoning" && p.id === event.partId, (p) =>
        ({ ...p, state: "done", providerMetadata: event.providerMetadata ?? (p as { providerMetadata?: Record<string, unknown> }).providerMetadata }) as Part,
      )
    case "tool-input-start":
      return upsertTool(message, event.toolCallId, (t) => ({
        ...t,
        toolName: event.toolName,
        runtime: event.runtime,
        state: "input-streaming",
        inputText: "",
        parentToolCallId: event.parentToolCallId,
      }))
    case "tool-input-delta":
      return updateTool(message, event.toolCallId, (t) => ({ ...t, inputText: (t.inputText ?? "") + event.delta }))
    case "tool-call":
      return upsertTool(message, event.toolCallId, (t) => ({
        ...t,
        toolName: event.toolName,
        runtime: event.runtime,
        input: event.input,
        inputText: undefined,
        title: event.title ?? t.title,
        state: "input-available",
        parentToolCallId: event.parentToolCallId ?? t.parentToolCallId,
        providerMetadata: event.providerMetadata ?? t.providerMetadata,
      }))
    case "tool-approval-request":
      return updateTool(message, event.toolCallId, (t) => ({
        ...t,
        state: "awaiting-approval",
        approval: { reason: event.reason, mode: event.mode },
      }))
    case "tool-approval-response":
      return updateTool(message, event.toolCallId, (t) => ({
        ...t,
        state: event.approved ? "input-available" : "denied",
        approval: { mode: t.approval?.mode ?? "wait", ...t.approval, approved: event.approved, message: event.message },
      }))
    case "tool-awaiting-output":
      return updateTool(message, event.toolCallId, (t) => ({ ...t, state: "awaiting-output" }))
    case "tool-start":
      return updateTool(message, event.toolCallId, (t) => ({ ...t, state: "running", startedAt: now() }))
    case "tool-progress": {
      const limit = options.progressLimit ?? 5
      return updateTool(message, event.toolCallId, (t) => ({
        ...t,
        progress: [...(t.progress ?? []), event.data].slice(-limit),
      }))
    }
    case "tool-result":
      return updateTool(message, event.toolCallId, (t) => ({
        ...t,
        state: event.isError ? (t.state === "denied" ? "denied" : "output-error") : "output-available",
        output: event.isError ? undefined : event.output,
        error: event.isError ? stringifyError(event.output) : undefined,
        endedAt: now(),
        providerMetadata: event.providerMetadata ?? t.providerMetadata,
      }))
    case "tool-child-session":
      return updateTool(message, event.toolCallId, (t) => ({ ...t, childSessionId: event.sessionId }))
    case "subagent": {
      if (!options.nestSubagents) return message
      return updateTool(message, event.toolCallId, (t) => ({
        ...t,
        childSessionId: event.sessionId,
        child: reduceMessage(
          t.child ?? { id: "", role: "assistant", parts: [], parentId: null, createdAt: now() },
          event.event,
          options,
        ),
      }))
    }
    case "data":
      if (event.transient) return message
      return upsertPart(message, (p) => p.type === "data" && p.id === event.part.id, () => event.part)
    case "file":
      return withParts(message, [...message.parts, event.part])
    case "source":
      return withParts(message, [...message.parts, event.part])
    case "step-finish":
      return message
    case "context-usage": {
      const { type: _type, ...usage } = event
      return { ...message, contextUsage: { ...usage, breakdown: usage.breakdown ?? message.contextUsage?.breakdown } }
    }
    case "run-finish":
      return { ...event.message }
    case "error":
      return { ...message, status: "error" }
    default:
      return message
  }
}

function stringifyError(output: unknown): string {
  if (typeof output === "string") return output
  if (output instanceof Error) return output.message
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function withParts(message: Message, parts: Part[]): Message {
  return { ...message, parts }
}

function updatePart(message: Message, match: (p: Part) => boolean, fn: (p: Part) => Part): Message {
  const i = findLastIndex(message.parts, match)
  if (i < 0) return message
  const parts = message.parts.slice()
  parts[i] = fn(parts[i]!)
  return withParts(message, parts)
}

function upsertPart(message: Message, match: (p: Part) => boolean, fn: (p: Part | undefined) => Part): Message {
  const i = findLastIndex(message.parts, match)
  const parts = message.parts.slice()
  if (i < 0) parts.push(fn(undefined))
  else parts[i] = fn(parts[i])
  return withParts(message, parts)
}

function updateTool(message: Message, toolCallId: string, fn: (t: ToolPart) => ToolPart): Message {
  return updatePart(message, (p) => p.type === "tool" && p.toolCallId === toolCallId, (p) => fn(p as ToolPart))
}

function upsertTool(message: Message, toolCallId: string, fn: (t: ToolPart) => ToolPart): Message {
  return upsertPart(message, (p) => p.type === "tool" && p.toolCallId === toolCallId, (p) =>
    fn(
      (p as ToolPart | undefined) ?? {
        type: "tool",
        toolCallId,
        toolName: "",
        state: "input-streaming",
        runtime: "server",
      },
    ),
  )
}

function findLastIndex<T>(arr: T[], fn: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i]!)) return i
  return -1
}

/**
 * Apply an event to a list of messages: inserts the user and assistant messages on
 * `run-start` and updates the assistant message after that. Handy for chat UIs.
 */
export function reduceMessages(messages: Message[], event: AgentEvent, assistantId: string | undefined, options?: ReduceOptions): Message[] {
  if (event.type === "run-start") {
    const out = messages.filter((m) => m.id !== event.message.id && m.id !== event.userMessage?.id)
    if (event.userMessage) out.push(event.userMessage)
    out.push(event.message)
    return out
  }
  if (!assistantId) return messages
  const i = messages.findIndex((m) => m.id === assistantId)
  if (i < 0) return messages
  const next = reduceMessage(messages[i]!, event, options)
  if (next === messages[i]) return messages
  const out = messages.slice()
  out[i] = next
  return out
}
