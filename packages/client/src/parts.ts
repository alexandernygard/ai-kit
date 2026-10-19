import type { ContextUsage, DataPart, FilePart, Message, ReasoningPart, SourcePart, TextPart, Todo, ToolPart } from "@alexandernygard/ai-kit"

/** A tool call with the calls it made (code mode) attached. */
export interface ToolNode extends ToolPart {
  children: ToolNode[]
}

export type Segment =
  | { kind: "text"; key: string; part: TextPart }
  | { kind: "reasoning"; key: string; part: ReasoningPart }
  /** Consecutive tool calls, for a trace or activity list. */
  | { kind: "tools"; key: string; tools: ToolNode[] }
  | { kind: "file"; key: string; part: FilePart }
  | { kind: "data"; key: string; part: DataPart }

/**
 * Group a message's parts the way chat UIs show them: text and reasoning blocks, runs of tool
 * calls (with code-mode calls nested under `run_code`), files and data. Step markers, internal
 * nudges and sources are left out; get sources with `sourcesOf`.
 */
export function segments(message: Message): Segment[] {
  const out: Segment[] = []
  const nodes = new Map<string, ToolNode>()
  for (const p of message.parts) {
    if (p.type === "tool") nodes.set(p.toolCallId, { ...p, children: [] })
  }
  for (const n of nodes.values()) {
    if (n.parentToolCallId && nodes.has(n.parentToolCallId)) nodes.get(n.parentToolCallId)!.children.push(n)
  }
  for (const p of message.parts) {
    switch (p.type) {
      case "text":
        if (p.text) out.push({ kind: "text", key: p.id, part: p })
        break
      case "reasoning":
        if (p.text) out.push({ kind: "reasoning", key: p.id, part: p })
        break
      case "tool": {
        if (p.parentToolCallId && nodes.has(p.parentToolCallId)) break
        const last = out.at(-1)
        const node = nodes.get(p.toolCallId)!
        if (last?.kind === "tools") last.tools.push(node)
        else out.push({ kind: "tools", key: p.toolCallId, tools: [node] })
        break
      }
      case "file":
        out.push({ kind: "file", key: p.id, part: p })
        break
      case "data":
        if (!p.name.startsWith("ai-kit.")) out.push({ kind: "data", key: p.id, part: p })
        break
    }
  }
  return out
}

export function sourcesOf(message: Message): SourcePart[] {
  return message.parts.filter((p): p is SourcePart => p.type === "source")
}

/** The latest todo list from `todo_write` in these messages. */
export function todosOf(messages: Message[]): Todo[] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const part = messages[i]!.parts.findLast((p): p is DataPart<Todo[]> => p.type === "data" && p.name === "todos")
    if (part) return part.data
  }
  return undefined
}

/** The latest context-window reading in these messages. */
export function contextUsageOf(messages: Message[]): ContextUsage | undefined {
  return messages.findLast((m) => m.role === "assistant" && m.contextUsage)?.contextUsage
}

/** A short status line for a tool call: "Searching flights", "Waiting for approval". */
export function toolLabel(t: ToolPart): string {
  const name = t.title ?? humanize(t.toolName)
  switch (t.state) {
    case "input-streaming":
    case "input-available":
      return name
    case "awaiting-approval":
      return `${name} (needs approval)`
    case "awaiting-output":
      return `${name} (waiting for you)`
    case "running":
      return name
    case "output-error":
      return `${name} failed`
    case "denied":
      return `${name} (denied)`
    default:
      return name
  }
}

export function isToolActive(t: ToolPart): boolean {
  return t.state === "input-streaming" || t.state === "input-available" || t.state === "running"
}

/** Seconds a tool ran for, when it has finished. */
export function toolDuration(t: ToolPart): number | undefined {
  return t.startedAt && t.endedAt ? (t.endedAt - t.startedAt) / 1000 : undefined
}

function humanize(name: string) {
  const short = name.startsWith("mcp__") ? name.split("__").slice(2).join(" ") : name
  const s = short.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}
