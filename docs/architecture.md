# Architecture

```
 browser                                server                                   model
 ───────                                ──────                                   ─────
 React / Svelte UI                      createHandler(kit)                        AI SDK model     (model driver)
   │  useChat / Chat                      │  auth → ownerId, context              Claude Code      (harness driver)
   │  reduceMessages(events)  ◀── SSE ────┤  Session.send / resume / respond       Codex            (harness driver)
   │  clientTools                         │                                          ▲
   └── POST /sessions/:id/messages ──────▶│  Runner ─── ModelRequest / HarnessRequest┘
                                          │    tools ── permissions ── hooks ── approvals
                                          │    Store: sessions, message tree, event log
```

## The pieces

**Kit.** Holds the agents, plugins, store and live runs. `createKit()` once per app. Plugins run their async `setup` the first time the kit is used.

**Agent.** Configuration only: instructions, a driver, tools, skills, subagents, permissions, hooks, limits, and the code-mode, tool-search and compaction settings. When a run starts, the kit resolves an agent by merging kit-wide, plugin and agent contributions in that order.

**Session.** A conversation stored as a tree of messages. `headId` points at the tip of the active branch, and `pathTo(messages, headId)` gives the conversation the model sees. Session `state` holds runtime facts that outlive a run: loaded tools and skills, todos, remembered approvals, compaction summaries, and the harness's own session ids.

**Run.** One agent turn. `session.send()` returns a `Run` right away. Iterate it for events, await `run.result`, call `abort()`, or answer waiting calls with `respond()`. Its events are buffered with sequence numbers, so any number of readers can join late, and they're also written to the store when it supports an event log.

**Runner.** The loop, in `runner.ts`. For a model driver:

1. Work out the tools for this step: visible tools, tools loaded by search, skill tools, built-ins, `task` for subagents, `search_tools` while anything is deferred, `run_code` in code mode, and `structured_output` when needed.
2. Build the system prompt: stable blocks first (instructions, skills index, toolkits, subagents) marked for caching, then dynamic blocks.
3. Turn the active path into provider-neutral `ModelTurn`s: steps split, unanswered calls dropped, old tool output trimmed, compaction applied.
4. Call `beforeModelCall` hooks, stream the step, and map driver events to `AgentEvent`s.
5. For each tool call: validate, run `beforeToolCall` hooks, check permissions, then ask, wait, suspend or execute (in parallel up to `toolConcurrency`), and finally run `afterToolCall` hooks.
6. Repeat until the model stops (`onStop` hooks can push it on), a limit is hit, or the run suspends for input.

For a harness driver the runner makes one `HarnessRequest` and maps what comes back. ai-kit's tools reach the harness as `BridgedTool`s that run the same validation, hooks, permissions and approvals. The harness's own tools (Bash, Edit) ask ai-kit through `canUseTool`.

**Events.** `AgentEvent` is the only output, and the same events go from runner to store to SSE to client. `reduceMessage(message, event)` is a pure function the runner uses to build what it stores and the client uses to render, so both sides agree by construction.

## Model drivers and harness drivers

| | Model driver | Harness driver |
| --- | --- | --- |
| Who runs the loop | ai-kit | Claude Code or Codex |
| Examples | `aiSdk(anthropic(...))`, `aiSdk(openai(...))` | `claudeAgent()`, `codex()` |
| Auth | API keys | Your subscription login, or an API key |
| ai-kit tools | Called directly | Bridged over MCP (in-process for Claude, localhost HTTP with a token for Codex) |
| Built-in coding tools | No | Yes, if you turn them on |
| Waiting for approvals | `suspend` (default) or `wait` | `wait` only (the harness process holds the turn) |
| Tool search | ai-kit's `search_tools` | All tools bridged; the harness defers them itself |
| Compaction | ai-kit's | The harness's |
| Resume and fork | From stored messages | From the harness session id, which ai-kit keeps in session state |

## Waiting for input

A tool call can need an answer from a person (approval) or from the browser (client tool). There are two ways to wait.

- **Suspend.** The run ends with `finishReason: "awaiting-input"` and the tool parts stay `awaiting-approval` or `awaiting-output`. The answers arrive later with `session.resume({ [toolCallId]: response })`, which continues the same assistant message. Nothing is held in memory, so it survives restarts and works on serverless.
- **Wait.** The run stays open and `run.respond(toolCallId, response)` unblocks it. Harness drivers always wait. Calls made from inside code mode always wait too, since a script can't be resumed halfway.

The `tool-approval-request` and `tool-awaiting-output` events carry `mode`, so a client knows whether to POST `/respond` (live) or resume. `Chat` handles both. It batches suspended answers until every pending call in the step is answered, then resumes once.

## Message shape

An assistant message holds a whole run:

```
[step 0] reasoning · text · tool(search_tools) ·
[step 1] tool(run_code) ─┬─ tool(get_orders, parentToolCallId=run_code)
                         └─ tool(refund,     parentToolCallId=run_code)
[step 2] text
```

Tool parts move through `input-streaming → input-available → (awaiting-approval | awaiting-output) → running → output-available | output-error | denied`. Subagent calls carry `childSessionId`; clients that reduce with `nestSubagents` also get the child's live message on `child`.

## Storage

`Store` is a small interface: session CRUD and listing, messages by session (upserted by id), and an optional event log. Built in:

- `memoryStore()` for tests, scripts and the browser
- `kvStore(kv)` for any get/set/delete/list store
- `sqlStore({ exec })` for SQLite, D1, Turso, Postgres (`sqlSchema()` has the DDL)
- `fileStore(dir)` from the node package

Messages are written when a run starts, after each step, at suspension and at the end. Events are batched every 250 ms. State is written at the end of the run.

## Design rules

- The core has no dependencies and no Node APIs, so it runs in browsers, Workers, Deno and Bun.
- Schemas are Standard Schema (zod 4, valibot, arktype) or JSON Schema.
- One event protocol and one reducer.
- Drivers are small interfaces. A new provider is one `stream()` function, and a new agent runtime is one `run()` generator.
- Security-relevant decisions (permissions, ownership, sandboxing) happen on the server, never from client input.
