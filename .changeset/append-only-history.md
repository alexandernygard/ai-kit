---
"@alexandernygard/ai-kit": minor
"@alexandernygard/ai-kit-anthropic": minor
"@alexandernygard/ai-kit-ai-sdk": patch
---

Keep history append-only so the prompt cache and Claude's thinking stay valid. Context providers are stored in the conversation where the model sees them (`ai-kit.context` parts) instead of being injected into the system prompt or the newest user turn each request; `system` placement becomes a mid-conversation system message. New driver capabilities: `contextManagement` (the provider compacts, so ai-kit stops summarizing and clearing tool output), `toolSearch` (deferred tools are declared up front with `defer: true`) and `forcedToolChoice: false` (a forced tool choice becomes "auto" plus a system message). `ModelTurn` gains a `system` role and assistant `raw` content for provider blocks, stored as `ai-kit.raw` parts. Reasoning in turns kept after a client-side compaction is no longer sent.

`claude()` now uses server-side compaction, server-side tool search and mid-conversation system messages where the model supports them, sends `prefix_mismatch_behavior: "drop_block"` on models with preserved thinking, defaults to `fallbacks: "default"` on Claude 5 models with the default client, and stores fallback boundary and compaction blocks and sends them back in place. `clearToolUses` turns on server-side tool-result clearing.
