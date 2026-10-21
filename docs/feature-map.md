# Feature map

How ai-kit lines up with what Claude, Claude Code and the Claude API offer, and what's left to build.

## Conversations

| Claude feature | ai-kit |
| --- | --- |
| Streaming text and thinking | reasoning parts, `effort`, `reasoningSummary` |
| Edit a message, retry, version arrows | `edit`, `regenerate`, `versions`, `switchBranch` |
| Branch a conversation | `fork()` |
| Projects and chat history | sessions with `ownerId`, `metadata` and listing |
| Chat titles | automatic, or from a model |
| Attachments (images, PDFs) | `file` parts |
| Stop | `abort` and `stop` |
| Pick up where you left off | reconnect by `seq`, event log |
| Memory | `memoryTool` (Anthropic's memory commands) |
| Context window indicator | `context-usage` events, `chat.contextUsage` |
| Page and selection context | `getContext` + `clientContext()` provider |
| Ask the user questions | `ask_user` + Questionnaire |
| Artifacts | a `data` part from `ctx.emit({ name: "artifact" })` and your renderer |
| Citations and web search | server tools in a tool's `provider` field |

## Agents (Claude Code and the Agent SDK)

| Claude Code | ai-kit |
| --- | --- |
| Tools and MCP | `tool`, `toolkit`, `mcpPlugin` |
| Permission modes and rules | `default` / `ask` / `plan` / `auto`; `allow`, `deny`, `ask` rules with `tool(pattern)` |
| "Always allow" | `remember: true` |
| Hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit, PreCompact, SubagentStart/Stop) | `beforeToolCall`, `afterToolCall`, `onStop`, `onUserMessage`, `beforeCompact`, `onSubagentStart/End` |
| Subagents | `subagents` + `task`, child sessions, parallel |
| Skills | Agent Skills folders, loaded on demand, with tools |
| Slash commands | `defineCommand` |
| Plugins | `definePlugin` |
| Todo list | `todo_write`, `todosOf` |
| Compaction | tool-output clearing, then summaries |
| Tool search | `defer` + `search_tools`, pluggable index |
| Code execution with tools ("code mode") | `codeMode` + `workerSandbox` |
| Structured output | `output` schemas |
| Budgets | `maxSteps`, `maxCostUsd`, `maxTokens`, `timeoutMs` |
| Sessions: resume, fork | stored message trees |
| File, search and shell tools | `fileTools`, `shellTool` (node) |

## API features

| Claude API | ai-kit |
| --- | --- |
| Prompt caching | Automatic breakpoints (`claude`, and `aiSdk` on Anthropic models) |
| Adaptive thinking, effort | `settings.effort`, `reasoningSummary`; `claude({ thinking })` or `providerOptions.anthropic` for the rest |
| Fallback on errors and refusals | `fallbackModels`; `claude({ fallbacks: "default" })` for server-side refusal fallback |
| Server tools (web search, web fetch, code execution) | `tool({ provider: { type: "web_search_20260209" } })`; `pause_turn` is resumed for you |
| Token counting and cost | `usage` per step and per run, priced from `defaultPricing` |
| Batches | Not wrapped. Call the Anthropic SDK directly. |
| Files API | Not wrapped. Pass files as parts, or URLs. |

## Not built yet

- **Realtime voice.** The AI SDK has realtime models. A voice transport for `Chat` would be a separate package.
- **Background and scheduled agents.** Runs keep going without a client. Queueing them (cron, retries, a job table) is up to the app for now; Workers Cron, Vercel Cron or a queue calling `kit.generate` covers most cases.
- **Durable runs across restarts.** A suspended run survives restarts. A run in the middle of a model call doesn't; it ends up `aborted` and the user retries. Full durability needs a workflow engine (Cloudflare Workflows, Inngest, Temporal) wrapping each step.
- **Evals.** Use the `mockModel` driver for deterministic tests. A small evals runner on `kit.generate` + `evaluateLoop` would be a good next package.
- **Embeddings and retrieval.** Bring your own; wrap search as a tool, or as a `ToolIndex` for semantic tool search.
- **A Svelte rune wrapper.** `Chat` already works as a Svelte store; a `.svelte.ts` class with `$state` would be nicer for Svelte 5 apps.
