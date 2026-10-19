# Drivers: API keys and subscriptions

Every agent has a `model`: a driver. Swap it and nothing else changes.

```ts
import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"
import { aiSdk } from "@alexandernygard/ai-kit-ai-sdk"
import { claudeAgent } from "@alexandernygard/ai-kit-claude-agent"
import { codex } from "@alexandernygard/ai-kit-codex"

model: aiSdk(anthropic("claude-opus-5-5"))       // Anthropic API key
model: aiSdk(openai("gpt-5.5"))                   // OpenAI API key
model: aiSdk("anthropic/claude-sonnet-5-5")       // Vercel AI Gateway
model: claudeAgent({ model: "claude-opus-5-5" })  // Claude Pro/Max subscription
model: codex({ model: "gpt-5.5-codex" })          // ChatGPT Plus/Pro subscription
```

## AI SDK (`aiSdk`)

Works with any AI SDK `LanguageModel`. ai-kit runs the loop, so every feature is available.

- **Prompt caching.** On Anthropic models it marks the stable system prompt and the newest message for caching, so each turn reads the previous one from cache. Turn it off with `{ cache: false }`, or use `{ cache: { ttl: "1h" } }`.
- **Effort.** `settings.effort` maps to the AI SDK's `reasoning` option. `reasoningSummary: true` asks Anthropic models for readable thinking summaries.
- **Provider tools.** Put an AI SDK provider tool in an ai-kit tool's `provider` field and the provider runs it:
  ```ts
  tool({ name: "web_search", description: "Search the web", provider: anthropic.tools.webSearch_20260209({ maxUses: 5 }) })
  ```
- **Structured output.** Uses the provider's JSON mode when the agent has no tools; otherwise the `structured_output` tool.
- **Provider options.** Pass through with `settings.providerOptions` or `aiSdk(model, { providerOptions })`.

## Claude Agent SDK (`claudeAgent`)

Runs a turn in Claude Code. Claude Code uses whatever it's logged in with:

- **Locally:** run `claude` and log in once. Your Pro or Max plan pays for usage.
- **On a server, with your subscription:** run `claude setup-token` and pass `env: { CLAUDE_CODE_OAUTH_TOKEN }`.
- **With an API key:** `env: { ANTHROPIC_API_KEY }`.

> Anthropic's consumer terms cover your own use of your subscription. For an app that other people use, bill an API key.

```ts
claudeAgent({
  model: "claude-opus-5-5",
  builtinTools: "claude_code",   // Read, Edit, Bash, Grep...; default [] = only your ai-kit tools
  claudeCodePrompt: true,        // Claude Code's system prompt + your instructions
  cwd: "/path/to/repo",
  permissionMode: "default",
  settingSources: [],            // don't read ~/.claude on a server (default)
  agents: { reviewer: { description: "...", prompt: "..." } }, // Claude Code's own subagents
})
```

How it works:

- Your ai-kit tools reach Claude Code through an in-process MCP server named `ai_kit`. Calls go through ai-kit's validation, hooks, permissions and approvals, and show up under the model's own tool-call ids.
- Claude Code's native tools ask ai-kit through `canUseTool`, so `permissions: { ask: ["Bash"], allow: ["Read"] }` applies to them as well.
- The harness session id is kept in session state. The next message resumes it, and `session.fork()` makes the next turn fork it.
- Usage and `total_cost_usd` come from Claude Code. Structured output uses its `outputFormat`.
- It uses Claude Code's own compaction. ai-kit's tool search is off here (Claude Code defers MCP tools itself), and ai-kit skills and subagents still work through the bridge.

## Codex (`codex`)

Runs a turn in OpenAI Codex. Leave `codex.apiKey` unset to use the ChatGPT login from `codex login`.

```ts
codex({
  model: "gpt-5.5-codex",
  sandboxMode: "read-only",      // or "workspace-write"
  workingDirectory: "/path/to/repo",
  webSearch: "live",
})
```

How it works:

- ai-kit tools go through a short-lived MCP endpoint on `127.0.0.1` with a random bearer token, created per run and closed after it. Codex is told to auto-approve that server (`default_tools_approval_mode = "approve"`) because ai-kit handles the approvals.
- Codex's SDK has no per-call approval hook, so its own shell and file tools are limited by `sandboxMode` rather than by ai-kit permissions.
- Shell commands show up as `shell` tool calls, file edits as `apply_patch`, the todo list as a `todos` data part, and reasoning as reasoning parts.
- Codex threads resume by id. Codex can't fork a thread, so a fork starts a new thread with the earlier conversation as context.

## Fallbacks

```ts
defineAgent({ model: aiSdk(anthropic("claude-opus-5-5")), fallbackModels: [aiSdk(openai("gpt-5.5"))] })
```

If a step fails before producing anything, the next model driver takes the step and a `status` event says so.

## Writing a driver

A model driver is one async generator:

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

A harness driver gets a `HarnessRequest` (input, history, `resumeId`, bridged tools, `canUseTool`) and yields `HarnessEvent`s. `mockModel` and `mockHarness` in `@alexandernygard/ai-kit/testing` are good references.
