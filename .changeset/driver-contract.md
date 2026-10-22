---
"@alexandernygard/ai-kit": minor
"@alexandernygard/ai-kit-anthropic": minor
---

Add `driverContract` to `@alexandernygard/ai-kit/testing`: a shared set of checks every `ModelDriver` must pass (streamed text, tool calls, tool results, abort, usage and errors). `claude()` now reads model support from one table, `CLAUDE_MODELS`, matched by longest id prefix; `claudeModelInfo(model)` looks a model up. A model id like `claude-opus-4-50` no longer matches `claude-opus-4-5`. The runner is split into modules under `runner/` with no change in behaviour.
