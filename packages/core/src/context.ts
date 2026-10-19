import type { ModelDriver, ModelRequest, ModelTurn, SystemBlock, ToolResultContent, ToolSpec } from "./driver"
import type { Message, ToolPart } from "./messages"

export interface CompactionOptions {
  /** Input tokens the model accepts. Defaults to the driver's `contextWindow`, then 200 000. */
  contextWindow?: number
  /** Compact when the request reaches this share of the window. Default 0.8. */
  threshold?: number
  /** Messages at the end kept word for word. Default 6. */
  keepRecent?: number
  /** Model that writes the summary. Defaults to the agent's model. */
  model?: ModelDriver
  /** Replace the summary instructions. */
  prompt?: string
  /**
   * Replace large tool outputs in older messages with a short note. This is cheap and often
   * enough on its own. Default `{ keepRecent: 3, minChars: 4000 }`; `false` turns it off.
   */
  clearToolResults?: false | { keepRecent?: number; minChars?: number }
}

export const COMPACTION_KEY = "ai-kit.compaction"

/** Data part for a user-side message inside an assistant message, e.g. from an `onStop` hook. */
export const NUDGE_PART = "ai-kit.nudge"

export interface CompactionState {
  /** Messages up to and including this one are replaced by `summary`. */
  uptoMessageId: string
  summary: string
}

export interface TurnOptions {
  compaction?: CompactionState
  clearToolResults?: false | { keepRecent?: number; minChars?: number }
  /** How tool outputs are shown to the model, by tool name. */
  toModelOutput?: (toolName: string, output: unknown) => ToolResultContent
}

const CLEARED = "[Output removed to save context. Run the tool again if you need it.]"

/**
 * Turn the active path of a session into provider-neutral model turns. Assistant messages are
 * split at step boundaries into assistant/tool turn pairs. Calls made inside code mode are left
 * out (the model only sees `run_code`'s result), as are calls still waiting on input.
 */
export function toModelTurns(path: Message[], options: TurnOptions = {}): ModelTurn[] {
  let messages = path
  const turns: ModelTurn[] = []
  if (options.compaction) {
    const i = path.findIndex((m) => m.id === options.compaction!.uptoMessageId)
    if (i >= 0) {
      messages = path.slice(i + 1)
      turns.push({
        role: "user",
        content: [{ type: "text", text: `<summary of the earlier conversation>\n${options.compaction.summary}\n</summary>` }],
      })
    }
  }

  const clear = options.clearToolResults === undefined ? { keepRecent: 3, minChars: 4000 } : options.clearToolResults
  const assistantIdx = messages.map((m, i) => (m.role === "assistant" ? i : -1)).filter((i) => i >= 0)
  const recentFrom = clear ? (assistantIdx[assistantIdx.length - (clear.keepRecent ?? 3)] ?? 0) : 0
  const out = options.toModelOutput ?? defaultModelOutput

  messages.forEach((m, mi) => {
    if (m.role === "system") return
    if (m.role === "user") {
      const content: Extract<ModelTurn, { role: "user" }>["content"] = []
      for (const p of m.parts) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text })
        else if (p.type === "file") content.push({ type: "file", mediaType: p.mediaType, data: p.url ?? p.data ?? "", filename: p.filename })
        else if (p.type === "data") content.push({ type: "text", text: `<${p.name}>\n${JSON.stringify(p.data)}\n</${p.name}>` })
      }
      if (content.length) turns.push({ role: "user", content })
      return
    }
    const clearHere = clear && mi < recentFrom
    let assistant: Extract<ModelTurn, { role: "assistant" }>["content"] = []
    let results: Extract<ModelTurn, { role: "tool" }>["content"] = []
    const flush = () => {
      if (assistant.length) turns.push({ role: "assistant", content: assistant })
      if (results.length) turns.push({ role: "tool", content: results })
      assistant = []
      results = []
    }
    for (const p of m.parts) {
      if (p.type === "step") flush()
      else if (p.type === "data" && p.name === NUDGE_PART) {
        flush()
        turns.push({ role: "user", content: [{ type: "text", text: String((p.data as { text?: string })?.text ?? "") }] })
      } else if (p.type === "text" && p.text) assistant.push({ type: "text", text: p.text })
      else if (p.type === "reasoning" && (p.text || p.providerMetadata)) {
        assistant.push({ type: "reasoning", text: p.text, providerMetadata: p.providerMetadata })
      } else if (p.type === "tool" && !p.parentToolCallId) {
        const result = toolResult(p, m.status, clearHere ? clear.minChars ?? 4000 : Infinity, out)
        if (!result) continue
        const providerExecuted = p.runtime === "provider"
        assistant.push({ type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.input ?? {}, providerExecuted, providerMetadata: p.providerMetadata })
        if (providerExecuted) assistant.push(result)
        else results.push(result)
      }
    }
    flush()
  })
  return mergeTurns(turns)
}

function defaultModelOutput(_name: string, output: unknown): ToolResultContent {
  return typeof output === "string" ? { type: "text", value: output } : { type: "json", value: output ?? null }
}

function toolResult(
  p: ToolPart,
  status: Message["status"],
  clearAbove: number,
  out: NonNullable<TurnOptions["toModelOutput"]>,
): Extract<ModelTurn, { role: "tool" }>["content"][number] | null {
  const base = { type: "tool-result" as const, toolCallId: p.toolCallId, toolName: p.toolName }
  switch (p.state) {
    case "output-available": {
      const output = out(p.toolName, p.output)
      if (JSON.stringify(output.value ?? "").length > clearAbove) return { ...base, output: { type: "text", value: CLEARED } }
      return { ...base, output }
    }
    case "output-error":
      return { ...base, output: { type: "text", value: p.error ?? "Tool failed" }, isError: true }
    case "denied":
      return {
        ...base,
        output: { type: "text", value: `The user denied this tool call.${p.approval?.message ? ` They said: ${p.approval.message}` : ""}` },
        isError: true,
      }
    case "awaiting-approval":
    case "awaiting-output":
      return null
    default:
      // A call that never finished (the run was aborted or crashed). Close it so the history stays valid.
      if (status === "streaming") return null
      return { ...base, output: { type: "text", value: "Interrupted before it finished." }, isError: true }
  }
}

/** Providers want alternating roles; merge neighbours with the same role. */
function mergeTurns(turns: ModelTurn[]): ModelTurn[] {
  const out: ModelTurn[] = []
  for (const t of turns) {
    const last = out[out.length - 1]
    if (last && last.role === t.role) (last.content as unknown[]).push(...t.content)
    else out.push({ role: t.role, content: [...t.content] } as ModelTurn)
  }
  return out
}

/** Rough token count: four characters a token. Close enough to decide when to compact. */
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return Math.ceil(s.length / 4)
}

export function estimateRequestTokens(req: { system: SystemBlock[]; messages: ModelTurn[]; tools: ToolSpec[] }): number {
  return estimateTokens(req.system.map((s) => s.text).join("\n")) + estimateTokens(req.messages) + estimateTokens(req.tools)
}

const SUMMARY_PROMPT = `Summarise the conversation so far so you can continue the task without the full history.
Keep: the user's goals and constraints, decisions made, facts learned (names, numbers, ids, paths), work done and its results, open questions, and what to do next.
Leave out pleasantries and anything that no longer matters. Write plain prose and short lists.`

/** Ask a model for a summary of `messages`. */
export async function summarize(
  model: ModelDriver,
  messages: Message[],
  options: { prompt?: string; signal: AbortSignal; previous?: string },
): Promise<string> {
  const turns = toModelTurns(messages, { clearToolResults: { keepRecent: 0, minChars: 2000 } })
  if (options.previous) {
    turns.unshift({ role: "user", content: [{ type: "text", text: `<earlier summary>\n${options.previous}\n</earlier summary>` }] })
  }
  turns.push({ role: "user", content: [{ type: "text", text: options.prompt ?? SUMMARY_PROMPT }] })
  const req: ModelRequest = {
    system: [{ text: "You write faithful, compact summaries of conversations." }],
    messages: mergeTurns(turns),
    tools: [],
    settings: { maxOutputTokens: 4000 },
    signal: options.signal,
  }
  let text = ""
  for await (const e of model.stream(req)) {
    if (e.type === "text-delta") text += e.delta
    if (e.type === "error") throw e.error instanceof Error ? e.error : new Error(String(e.error))
  }
  return text.trim()
}
