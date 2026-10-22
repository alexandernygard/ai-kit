/** What a Claude model supports. Drives `claude()`'s defaults; its options override them. */
export interface ClaudeModelInfo {
  /** Server-side fallbacks (`fallbacks`). */
  fallbacks?: boolean
  /** Server-side compaction (`compact_20260112`). */
  compaction?: boolean
  /** Mid-conversation `role: "system"` messages. */
  systemMessages?: boolean
  /** Thinking is kept across turns, so `block_binding` applies. */
  preservedThinking?: boolean
  /** `false` when a forced `tool_choice` ("any" or a named tool) returns a 400. */
  forcedToolChoice?: boolean
  /** Server-side tool search (`defer_loading`). */
  toolSearch?: boolean
}

const CLAUDE_5 = { fallbacks: true, compaction: true, systemMessages: true, toolSearch: true }

/**
 * Known models by id prefix. The longest matching prefix wins, so a dated or provider-prefixed id
 * (`claude-opus-5-5-20260301`, `us.anthropic.claude-opus-5-5-v1`) finds its entry. Adding a model
 * is one line here.
 */
export const CLAUDE_MODELS: Record<string, ClaudeModelInfo> = {
  "claude-fable-5": CLAUDE_5,
  "claude-fable-5-1": { ...CLAUDE_5, preservedThinking: true, forcedToolChoice: false },
  "claude-mythos-5": CLAUDE_5,
  "claude-mythos-5-1": { ...CLAUDE_5, preservedThinking: true },
  "claude-mythos-preview": { compaction: true },
  "claude-opus-5": CLAUDE_5,
  "claude-opus-5-5": { ...CLAUDE_5, preservedThinking: true, forcedToolChoice: false },
  "claude-sonnet-5": { fallbacks: true, compaction: true, toolSearch: true },
  "claude-sonnet-5-5": { ...CLAUDE_5, preservedThinking: true, forcedToolChoice: false },
  "claude-haiku-5": { fallbacks: true },
  "claude-haiku-5-5": { fallbacks: true, compaction: true, preservedThinking: true, toolSearch: true },
  "claude-opus-4-8": { compaction: true, systemMessages: true, toolSearch: true },
  "claude-opus-4-7": { compaction: true, toolSearch: true },
  "claude-opus-4-6": { compaction: true, toolSearch: true },
  "claude-opus-4-5": { toolSearch: true },
  "claude-sonnet-4-6": { compaction: true, toolSearch: true },
  "claude-sonnet-4-5": { toolSearch: true },
  "claude-haiku-4-5": { toolSearch: true },
}

/** The table entry for a model id; `{}` for models it doesn't know. */
export function claudeModelInfo(model: string, table: Record<string, ClaudeModelInfo> = CLAUDE_MODELS): ClaudeModelInfo {
  let best: string | undefined
  for (const key of Object.keys(table)) {
    const at = model.indexOf(key)
    // The prefix must end the id or be followed by a non-digit: `claude-opus-4-5` isn't `claude-opus-4-50`.
    if (at < 0 || /\d/.test(model[at + key.length] ?? "")) continue
    if (!best || key.length > best.length) best = key
  }
  return best ? table[best]! : {}
}
