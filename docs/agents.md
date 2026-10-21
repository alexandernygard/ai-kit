# Agents, tools and approvals

## Agents

```ts
const agent = defineAgent({
  name: "support",
  description: "Customer support",            // shown when it's offered as a subagent
  instructions: ({ context }) => `You help ${context.user.name}.`,
  model: claude("claude-opus-5-5"),
  fallbackModels: [claude("claude-sonnet-5-5")],
  settings: { effort: "medium", maxOutputTokens: 16000 },
  tools: [lookupOrder, refundToolkit],
  skills: await loadSkills("./skills"),
  subagents: [researcher],
  commands: [reviewCommand],
  plugins: [billingPlugin],
  hooks: { beforeToolCall: audit },
  permissions: { mode: "default", deny: ["delete_*"] },
  limits: { maxSteps: 25, maxCostUsd: 0.5, timeoutMs: 120_000, toolConcurrency: 8 },
  builtins: { askUser: true, todos: true },
  codeMode: false,
  compaction: { contextWindow: 200_000 },
})
```

`context` is whatever you pass per run, `session.send(text, { context })`, or what the server's `auth` returns. Tools, hooks and instructions all see it. Put the current user, a database handle or feature flags there.

## Tools

```ts
const refund = tool({
  name: "refund_order",
  description: "Refund an order to the original payment method.",
  input: z.object({ orderId: z.string(), amount: z.number().positive() }),
  needsApproval: (input) => input.amount > 500,       // or true
  destructive: true,
  title: (i) => `Refunding ${i.amount} kr`,           // label in the UI
  timeoutMs: 30_000,
  async execute({ orderId, amount }, ctx) {
    ctx.progress({ step: "contacting bank" })         // live progress in the UI
    const r = await payments.refund(orderId, amount, { signal: ctx.signal })
    ctx.state.set("lastRefund", r.id)                  // session-scoped state
    return r
  },
})
```

| Field | Meaning |
| --- | --- |
| `input` | zod (or any Standard Schema) or JSON Schema. Invalid input goes back to the model as an error so it can retry. |
| `execute` | Can return a value, a promise, or an async generator (each `yield` is progress, the `return` is the output). |
| `runtime` | `client` when there's no `execute`: the browser answers it. |
| `readOnly` | Allowed in `plan` mode; also used by MCP and UIs. |
| `defer`, `keywords` | Hide it until tool search finds it. |
| `codeMode` | Set `false` to keep it out of `run_code`. |
| `permissionKey` | What `bash(git *)`-style rules match against. |
| `toModelOutput` | Shape what the model sees (text, JSON, or content with images). |
| `sequential` | Don't run alongside other calls from the same step. |
| `provider` | A provider-executed tool, such as web search. |

`ToolContext` gives you `signal`, `context`, `state`, `messages()`, `progress()`, `emit()` (add a data part for custom UI) and `callTool()` (call another tool through the full pipeline).

Group tools with `toolkit({ name, description, instructions, tools, defer })`.

## Client tools

A tool without `execute` runs in the browser:

```ts
const getLocation = tool({ name: "get_location", description: "The user's location" })

// browser
useChat({ clientTools: { get_location: () => getPosition() } })
```

Or render it as UI and answer with `chat.submitToolOutput(toolCallId, value)`. The built-in `ask_user` is a client tool; the example renders it with the Questionnaire component.

## Permissions

Calls are checked in this order. The first match decides.

1. `beforeToolCall` hooks. `deny` and `ask` win; an explicit `allow` skips the prompt (deny rules still apply).
2. `deny` rules.
3. Tools the user chose to "always allow" in this session.
4. `allow` rules.
5. Mode `plan` denies anything that isn't `readOnly`.
6. `canUseTool(call, ctx)`, if set.
7. Mode `auto` allows everything left.
8. `ask` rules, and mode `ask` for anything not read-only.
9. The tool's `needsApproval`.

Rules are globs on the tool name (`mcp__github__*`) or name plus key (`bash(npm test*)`), or `{ tool, when: (input) => boolean }`. Kit, plugin and agent permissions merge, and `send(..., { permissionMode })` overrides the mode for one run.

## Answering approvals

```ts
const run = session.send("Clean up old invoices")
const result = await run.result
if (result.finishReason === "awaiting-input") {
  for (const call of result.pending) console.log(call.toolName, call.input, call.approval?.reason)
  await session.resume({ [result.pending[0].toolCallId]: { approved: true } }).result
}
```

A response is `{ approved, message?, input?, remember? }` for approvals (`input` runs an edited version; `message` tells the model why you said no) or `{ output, isError? }` for client tools. To decide in code instead, pass `onToolApproval: (call) => ({ approved: ... })` to `send`.

## Hooks

```ts
hooks: {
  onUserMessage: (m) => (containsSecrets(m) ? { block: "Don't paste secrets." } : undefined),
  beforeModelCall: (req) => ({ ...req, system: [...req.system, { text: `Today is ${today()}` }] }),
  beforeToolCall: (call) => (call.toolName === "bash" && /rm -rf/.test(call.input.command) ? { decision: "deny", reason: "No." } : undefined),
  afterToolCall: (call) => ({ output: redact(call.output) }),
  onStop: async ({ step }) => ((await testsPass()) ? undefined : { continue: "The tests still fail. Fix them." }),
  onRunEnd: ({ usage }) => meter.record(usage),
  onEvent: (e) => log(e),
}
```

## Structured output

```ts
const { output } = await kit.generate("Extract the invoice", { agent: "extractor", output: z.object({ total: z.number(), due: z.string() }) })
```

`output` is validated. ai-kit uses the provider's JSON mode when the agent has no tools, otherwise a `structured_output` tool. If the answer doesn't validate, the model gets one retry.

## Built-in tools

- `askUserTool()`: one to four multiple-choice questions, answered in the UI.
- `todoTool()`: the agent keeps a task list; UIs read it with `todosOf(messages)`.
- `memoryTool(kv, { namespace: (ctx) => ctx.user.id })`: Anthropic-style `/memories` files that persist across sessions.

Turn the first two on with `builtins: { askUser: true, todos: true }`; add `memoryTool` to `tools`.

## Subagents

```ts
defineAgent({ name: "lead", subagents: [researcher, writer], ... })
```

The lead gets a `task` tool. Each call runs the subagent in a child session (`parentSessionId`, `parentToolCallId`), streams its events nested under the call, and returns its final answer or structured output. Independent tasks run in parallel. Approvals inside a subagent go to the parent run's `respond()`.

## Slash commands

```ts
defineCommand({ name: "review", description: "Review a file", argumentHint: "<path>", prompt: (args) => `Review ${args} for bugs.` })
```

`/review app.ts` expands before the agent sees it, and the original is kept in the message's metadata. `kit.agents()` lists commands for autocomplete.

## Workflows

For orchestration you write in code rather than leave to the model:

```ts
await chain(kit, input, [{ agent: "outline" }, { agent: "draft" }, { agent: "edit" }])
await parallel(kit, files.map((f) => ({ agent: "reviewer", prompt: f })), { concurrency: 4 })
await route(kit, question, { router: "triage", routes: { billing: "billing", tech: "support" } })
await evaluateLoop(kit, task, { generator: "writer", evaluator: "critic", maxRounds: 3 })
```
