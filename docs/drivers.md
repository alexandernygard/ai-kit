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
  fallbacks: "default",   // server-side fallback on refusals; default on Claude 5 models with the default client
  compaction: { instructions: "Keep file paths." }, // server-side compaction; default on where supported
  clearToolUses: true,    // server-side clearing of old tool results; off by default
  toolSearch: "bm25",     // server-side tool search for deferred tools; or "regex", or false
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
- **Append-only history.** Claude's thinking is only valid in the conversation that produced it: the system prompt, the tools and every earlier message must come back unchanged. ai-kit keeps them so. Context goes into the conversation as messages instead of the system prompt, deferred tools are declared from the start, and compaction and tool-result clearing happen on the server. As a safety net, models with preserved thinking get `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, so stale reasoning is dropped instead of failing the request; set `thinkingBinding: "error"` in tests to catch edits, or `false` to leave it unset.
- **Compaction.** On by default where the model supports it. When the prompt reaches the agent's `compaction.threshold` of the context window (at least 50 000 tokens), the API summarizes the earlier conversation. The compaction block is stored in the message and sent back, a `status` event reports `compacted`, and its tokens are counted in usage. `compaction.prompt` becomes the summarization instructions. `compaction: false` on the agent or the driver turns it off; with the driver option off, ai-kit summarizes on its own.
- **Tool search.** Deferred tools (`defer: true`) are sent with `defer_loading: true` next to the `tool_search_tool_bm25` server tool, which loads them as the model needs them. Keep the tools used on most turns undeferred.
- **System messages.** Context with `placement: "system"` and ai-kit's own instructions go as mid-conversation `role: "system"` messages on the models that support them, and as user text elsewhere (`systemMessages` overrides the choice).
- **Refusals.** `stop_reason: "refusal"` ends the step with finish reason `content-filter`. With `fallbacks: "default"` the API retries on another model instead. A fallback in the middle of a reply leaves a `fallback` boundary block, which is stored and sent back in place; the declining model's thinking and tool calls before it are left out, along with their results. Bedrock, Vertex and Foundry clients don't support server-side fallbacks, so pass `fallbacks` explicitly only on the Claude API.
- **Forced tool choice.** Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 reject `toolChoice: "required"` or `{ tool }`. On those models ai-kit sends `"auto"` and a system message naming the tool.
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
