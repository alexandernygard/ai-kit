import {
  COMPACTION_KEY,
  type CompactionState,
  CONTEXT_PART,
  type ContextPartData,
  estimateRequestTokens,
  estimateTokens,
  summarize,
  toModelTurns,
} from "../context"
import { renderContext, type ResolvedContext } from "../context-providers"
import type { Driver, ModelDriver, ModelRequest } from "../driver"
import type { ContextUsage } from "../events"
import { createId } from "../id"
import type { DataPart, Message } from "../messages"
import { toModelOutput } from "../tools"
import { contextWindowFor, type Usage } from "../usage"
import type { RunContext } from "./run-context"

/** The conversation as model turns. */
export function turns(rc: RunContext, driver: Driver) {
  // Clearing old tool outputs edits history; drivers that manage context do it on the provider's side.
  const managed = driver.capabilities?.contextManagement === true
  return toModelTurns(rc.path(), {
    compaction: rc.state[COMPACTION_KEY] as CompactionState | undefined,
    clearToolResults: rc.agent.compaction === false || managed ? false : rc.agent.compaction?.clearToolResults,
    toModelOutput: (name, output) => toModelOutput(rc.tools.get(name), output),
  })
}

/**
 * Store context in the message at the point the model sees it, so the next request sends the
 * same history. A provider's text is only stored again when it changed. `system` placement
 * becomes a system message; `turn` placement stays user-side text.
 */
export function storeContext(rc: RunContext, contexts: ResolvedContext[]) {
  if (!contexts.length) return
  const last = new Map<string, string>()
  for (const m of rc.path()) {
    for (const p of m.parts) {
      if (p.type === "data" && p.name === CONTEXT_PART) {
        const c = p.data as ContextPartData
        last.set(c.name, c.text)
      }
    }
  }
  for (const c of contexts) {
    if (last.get(c.name) === c.text) continue
    addContext(rc, { name: c.name, role: c.placement === "system" ? "system" : "user", text: c.text })
  }
}

export function addContext(rc: RunContext, data: ContextPartData) {
  const part: DataPart<ContextPartData> = { type: "data", id: createId("ctx", 8), name: CONTEXT_PART, data }
  rc.emit({ type: "data", part })
}

/** Compaction settings for drivers that compact on the provider's side. */
export function contextManagement(rc: RunContext, driver: Driver): ModelRequest["contextManagement"] {
  if (driver.capabilities?.contextManagement !== true) return undefined
  const opts = rc.agent.compaction
  if (opts === false) return false
  return { compactAtTokens: Math.floor(contextWindow(rc) * (opts?.threshold ?? 0.8)), instructions: opts?.prompt }
}

/** Run every provider due at this step. Run-scoped results are computed once and reused. */
export async function resolveContext(rc: RunContext, step: number): Promise<ResolvedContext[]> {
  const providers = rc.resolved.contextProviders
  if (!providers.length) return []
  const messages = rc.path()
  const out: ResolvedContext[] = []
  await Promise.all(
    providers.map(async (p) => {
      let text: string | undefined
      if (p.refresh !== "step" && rc.runContext.has(p.name)) text = rc.runContext.get(p.name)
      else {
        try {
          const value = await p.get({
            agent: rc.agent.name,
            sessionId: rc.input.session.id,
            context: rc.input.options.context,
            clientContext: rc.input.options.clientContext,
            state: rc.state,
            messages,
            step,
          })
          text = renderContext(p.name, value)
        } catch (e) {
          rc.emit({ type: "status", status: "context-error", detail: `${p.name}: ${e instanceof Error ? e.message : String(e)}` })
        }
        if (p.refresh !== "step") rc.runContext.set(p.name, text)
      }
      if (text) out.push({ name: p.name, placement: p.placement ?? "turn", text })
    }),
  )
  // Keep the configured order regardless of which provider finished first.
  const order = new Map(providers.map((p, i) => [p.name, i]))
  return out.sort((a, b) => order.get(a.name)! - order.get(b.name)!)
}

/** The model's context window: configured, then reported by the driver, then the built-in table. */
function contextWindow(rc: RunContext): number {
  const d = rc.driver
  const fromCompaction = rc.agent.compaction ? rc.agent.compaction.contextWindow : undefined
  return fromCompaction ?? d.capabilities?.contextWindow ?? contextWindowFor(d.modelId, rc.host.contextWindows) ?? 200_000
}

function compactAt(rc: RunContext): number | undefined {
  if (rc.agent.compaction === false) return undefined
  return rc.agent.compaction?.threshold ?? 0.8
}

export function emitEstimate(rc: RunContext, step: number, request: ModelRequest): NonNullable<ContextUsage["breakdown"]> {
  const system = estimateTokens(request.system.map((b) => b.text).join("\n"))
  const tools = estimateTokens(request.tools)
  // Context lives in the message history, so it's taken out of `messages` to keep the sections apart.
  const context = contextTokens(rc.path(), rc.state[COMPACTION_KEY] as CompactionState | undefined)
  const inContext = context.reduce((n, c) => n + c.tokens, 0)
  const messages = Math.max(0, estimateTokens(request.messages) - inContext)
  const breakdown = { system, tools, messages, context, output: 0 }
  emitUsage(rc, { step, tokens: system + tools + messages + inContext, source: "estimate", breakdown })
  return breakdown
}

/**
 * What the provider counted: the whole prompt (cached or not) plus the reply. The estimate's
 * sections are scaled to the measured prompt so they still add up to `tokens`.
 */
export function emitMeasured(rc: RunContext, step: number, usage: Usage, estimate: NonNullable<ContextUsage["breakdown"]>) {
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const tokens = input + usage.outputTokens
  if (tokens <= 0) return
  const [system, tools, messages, ...context] = apportion(input, [estimate.system, estimate.tools, estimate.messages, ...estimate.context.map((c) => c.tokens)])
  const breakdown = { system: system!, tools: tools!, messages: messages!, context: estimate.context.map((c, i) => ({ name: c.name, tokens: context[i]! })), output: usage.outputTokens }
  emitUsage(rc, { step, tokens, source: "provider", breakdown })
}

/** Split `total` in proportion to `weights`, rounding so the parts add up exactly (largest remainder). */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const exact = weights.map((w) => (w / sum) * total)
  const parts = exact.map(Math.floor)
  let left = total - parts.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left-- <= 0) break
    parts[i]!++
  }
  return parts
}

/** Tokens of the context stored in the history the model sees, by provider, in first-seen order. */
function contextTokens(path: Message[], compaction: CompactionState | undefined): Array<{ name: string; tokens: number }> {
  const from = compaction ? path.findIndex((m) => m.id === compaction.uptoMessageId) + 1 : 0
  const totals = new Map<string, number>()
  for (const m of path.slice(from)) {
    for (const p of m.parts) {
      if (p.type !== "data" || p.name !== CONTEXT_PART) continue
      const c = p.data as ContextPartData
      totals.set(c.name, (totals.get(c.name) ?? 0) + estimateTokens(c.text))
    }
  }
  return [...totals].map(([name, tokens]) => ({ name, tokens }))
}

function emitUsage(rc: RunContext, u: Omit<ContextUsage, "window" | "ratio" | "compactAt">) {
  const window = contextWindow(rc)
  rc.emit({ type: "context-usage", ...u, window, ratio: Math.min(1, u.tokens / window), compactAt: compactAt(rc) })
}

/** ai-kit's own compaction, for drivers that don't compact on the provider's side. */
export async function maybeCompact(rc: RunContext, driver: ModelDriver, request: ModelRequest): Promise<boolean> {
  const opts = rc.agent.compaction
  if (opts === false || driver.capabilities?.contextManagement === true) return false
  const windowSize = contextWindow(rc)
  const threshold = opts?.threshold ?? 0.8
  const tokens = estimateRequestTokens(request)
  if (tokens < windowSize * threshold) return false
  const keep = opts?.keepRecent ?? 6
  const path = [...rc.input.history, ...(rc.input.userMessage ? [rc.input.userMessage] : [])]
  const prev = rc.state[COMPACTION_KEY] as CompactionState | undefined
  const start = prev ? path.findIndex((m) => m.id === prev.uptoMessageId) + 1 : 0
  const candidates = path.slice(start, Math.max(start, path.length - keep))
  if (!candidates.length) return false
  if (!(await rc.resolved.hooks.beforeCompact({ messages: candidates, tokens }, rc.hookCtx))) return false
  rc.emit({ type: "status", status: "compacting", detail: `About ${tokens} tokens` })
  const summary = await summarize(opts?.model ?? driver, candidates, { prompt: opts?.prompt, signal: rc.signal, previous: prev?.summary })
  // The kept turns' reasoning was signed against the full history, so it can't be sent after the summary.
  const state: CompactionState = { uptoMessageId: candidates.at(-1)!.id, summary, reasoningBefore: { messageId: rc.message.id, parts: rc.message.parts.length } }
  rc.stateAccess().set(COMPACTION_KEY, state)
  rc.emit({ type: "compaction", summary, uptoMessageId: state.uptoMessageId })
  return true
}
