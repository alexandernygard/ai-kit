export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Cost in USD: reported by the driver, or worked out from the pricing table. */
  costUsd?: number
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 })

export function addUsage(a: Usage | undefined, b: Usage | undefined): Usage {
  const x = a ?? emptyUsage()
  const y = b ?? emptyUsage()
  const sum = (p?: number, q?: number) => (p === undefined && q === undefined ? undefined : (p ?? 0) + (q ?? 0))
  return {
    inputTokens: x.inputTokens + y.inputTokens,
    outputTokens: x.outputTokens + y.outputTokens,
    cacheReadTokens: sum(x.cacheReadTokens, y.cacheReadTokens),
    cacheWriteTokens: sum(x.cacheWriteTokens, y.cacheWriteTokens),
    reasoningTokens: sum(x.reasoningTokens, y.reasoningTokens),
    costUsd: sum(x.costUsd, y.costUsd),
  }
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Anthropic first-party prices (October 2026) used when a driver doesn't report cost. Keys match
 * `modelId` by prefix, longest first. Cache writes are the 5-minute rate (1.25x input).
 * Add other providers' models with `createKit({ pricing })`. Prices change; check the pricing page.
 */
export const defaultPricing: Record<string, ModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
}

/**
 * Context windows by model id prefix, longest first. Claude models from Opus 4.6 on have 1M
 * tokens; Haiku 4.5 has 200K. Add others with `createKit({ contextWindows })` or a driver's
 * `capabilities.contextWindow`.
 */
export const defaultContextWindows: Record<string, number> = {
  "claude-haiku-4-5": 200_000,
  "claude-": 1_000_000,
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 1_000_000,
}

export function contextWindowFor(modelId: string | undefined, table: Record<string, number> = defaultContextWindows): number | undefined {
  if (!modelId) return undefined
  const id = modelId.includes(":") ? modelId.slice(modelId.indexOf(":") + 1) : modelId
  const key = Object.keys(table)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return key ? table[key] : undefined
}

export function priceFor(modelId: string | undefined, table: Record<string, ModelPrice>): ModelPrice | undefined {
  if (!modelId) return undefined
  const id = modelId.includes(":") ? modelId.slice(modelId.indexOf(":") + 1) : modelId
  const key = Object.keys(table)
    .filter((k) => id.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return key ? table[key] : undefined
}

export function costOf(usage: Usage, price: ModelPrice | undefined): number | undefined {
  if (!price) return undefined
  const m = 1_000_000
  return (
    (usage.inputTokens * price.input) / m +
    (usage.outputTokens * price.output) / m +
    ((usage.cacheReadTokens ?? 0) * (price.cacheRead ?? price.input)) / m +
    ((usage.cacheWriteTokens ?? 0) * (price.cacheWrite ?? price.input)) / m
  )
}
