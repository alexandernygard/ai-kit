# Drivers

Every agent has a `model`: a driver. A driver makes one model call and ai-kit runs the loop around it, so every feature works with every driver. Swap it and nothing else changes.

```ts
import { claude } from "@alexandernygard/ai-kit-anthropic"
import { aiSdk } from "@alexandernygard/ai-kit-ai-sdk"
import { openai } from "@ai-sdk/openai"

model: claude("claude-opus-5-5")     // the Claude API, through the Anthropic SDK
model: aiSdk(openai("gpt-5.5"))       // any AI SDK provider
model: aiSdk("anthropic/claude-sonnet-5-5") // Vercel AI Gateway
```

## Claude API (`claude`)

Calls the Messages API with the official `@anthropic-ai/sdk`, streaming every request.

```ts
claude("claude-opus-5-5", {
  client,                 // an Anthropic client, or a Bedrock / Vertex / Foundry one; default new Anthropic()
  maxTokens: 64_000,      // max_tokens when the agent sets no maxOutputTokens
  cache: { ttl: "1h" },   // prompt-cache breakpoints; default on with the 5-minute TTL
  thinking: { type: "adaptive", display: "summarized" },
  fallbacks: "default",   // server-side fallback on refusals (off by default, see below)
  params: { inference_geo: "us" }, // merged into every request
})
```

- **Credentials.** `ANTHROPIC_API_KEY`, or a profile from `ant auth login`. Pass `clientOptions` or your own `client` for anything else.
- **Prompt caching.** A breakpoint goes after the stable system prompt (instructions, skills, toolkits, subagents) and on the newest message, so each step reads the previous one from cache. `usage.cacheReadTokens` shows the hits. Turn it off with `{ cache: false }`.
- **Thinking and effort.** Current models think adaptively when `thinking` is left out. `settings.effort` maps to `output_config.effort` (`minimal` becomes `low`). Claude Opus 5.5 defaults to `medium`, so set effort on agents that need more. `reasoningSummary: true` asks for readable thinking summaries; without it thinking streams empty. Thinking blocks are stored with their signatures and sent back unchanged.
- **Tools.** Tool inputs stream as they're generated (`eager_input_streaming`). The API doesn't check them in that mode, so ai-kit validates each one against its schema and rejects input that isn't a JSON object. Turn it off with `eagerInputStreaming: false`.
- **Server tools.** Put the tool definition in an ai-kit tool's `provider` field. Results come back as provider-executed tool parts and are sent back to the API unchanged next turn. Long server-tool turns that end in `pause_turn` are resumed within the step.
  ```ts
  tool({ name: "web_search", description: "Search the web", provider: { type: "web_search_20260209", max_uses: 5 } })
  ```
- **Structured output.** Uses `output_config.format` when the agent has no tools; otherwise the `structured_output` tool.
- **Refusals.** `stop_reason: "refusal"` ends the step with finish reason `content-filter`. `fallbacks: "default"` lets the API retry on another model. It's off by default because a fallback in the middle of a reply leaves a boundary block that has to be sent back in place, and ai-kit's message format doesn't keep it yet.
- **Forced tool choice.** `toolChoice: "required"` or `{ tool }` returns a 400 on Claude Opus 5.5, Sonnet 5.5 and Fable 5.1. Use `"auto"` and say which tool to use in the prompt.
- **Overrides.** `settings.providerOptions.anthropic` is merged into the request body last, and `settings.headers` go on each request.

## AI SDK (`aiSdk`)

Works with any AI SDK `LanguageModel`.

- **Prompt caching.** On Anthropic models it marks the stable system prompt and the newest message for caching. Turn it off with `{ cache: false }`, or use `{ cache: { ttl: "1h" } }`.
- **Effort.** `settings.effort` maps to the AI SDK's `reasoning` option. `reasoningSummary: true` asks Anthropic models for readable thinking summaries.
- **Provider tools.** Put an AI SDK provider tool in an ai-kit tool's `provider` field and the provider runs it:
  ```ts
  tool({ name: "web_search", description: "Search the web", provider: anthropic.tools.webSearch_20260209({ maxUses: 5 }) })
  ```
- **Structured output.** Uses the provider's JSON mode when the agent has no tools; otherwise the `structured_output` tool.
- **Provider options.** Pass through with `settings.providerOptions` or `aiSdk(model, { providerOptions })`.

## Fallbacks

```ts
defineAgent({ model: claude("claude-opus-5-5"), fallbackModels: [claude("claude-sonnet-5-5")] })
```

If a step fails before producing anything, the next driver takes the step and a `status` event says so.

## Writing a driver

A driver is one async generator:

```ts
const myModel: ModelDriver = {
  kind: "model",
  provider: "acme",
  modelId: "acme-1",
  async *stream(req) {
    // req.system, req.messages (ModelTurn[]), req.tools (JSON Schema), req.settings, req.signal
    yield { type: "text-delta", id: "t", delta: "Hello" }
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 2 } }
  },
}
```

`mockModel` in `@alexandernygard/ai-kit/testing` is a good reference.
