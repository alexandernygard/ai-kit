# @alexandernygard/ai-kit-anthropic

Model driver for the Claude API through the official Anthropic SDK, with prompt caching, adaptive thinking and effort, server tools, structured output and `pause_turn` handling.

```bash
pnpm add @alexandernygard/ai-kit-anthropic @anthropic-ai/sdk
```

```ts
import { claude } from "@alexandernygard/ai-kit-anthropic"

defineAgent({ name: "support", model: claude("claude-opus-5-5"), settings: { effort: "high" } })
```

Docs: [drivers](../../docs/drivers.md). Overview: [ai-kit README](../../README.md).
