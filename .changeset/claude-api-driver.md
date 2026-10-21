---
"@alexandernygard/ai-kit": minor
"@alexandernygard/ai-kit-anthropic": minor
"@alexandernygard/ai-kit-mcp": minor
---

Add `@alexandernygard/ai-kit-anthropic`, a driver for the Claude API on the official Anthropic SDK. Remove harness drivers: the Claude Agent SDK and Codex packages are gone, along with `HarnessDriver`, `mockHarness`, the `harness` tool runtime and the `HARNESS_*` state keys. `createMcpServer` now takes plain ai-kit tools. Tool calls whose input isn't a JSON object are rejected before they run.
