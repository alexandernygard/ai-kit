# Context: providers, usage, tool search, code mode, skills, compaction

## Context providers

Context providers attach live information to every model call, such as who the user is, what's on their screen, the time or the open document, so you don't have to rebuild instructions by hand.

```ts
import { clientContext, currentTime, defineContext } from "@alexandernygard/ai-kit"

defineAgent({
  ...,
  contextProviders: [
    defineContext({ name: "user", get: async ({ context }) => ({ name: context.user.name, plan: await plans.of(context.user.id) }) }),
    defineContext({ name: "rules", placement: "system", get: () => "Prices include VAT." }),
    currentTime({ timeZone: "Europe/Oslo" }),
    clientContext({ pick: ["route", "selection"] }),
  ],
})
```

The model sees each one as `<context name="user">...</context>`. A provider returns text, an object (sent as JSON) or nothing (skipped). It gets the trusted `context`, the untrusted `clientContext`, session `state`, the `messages` the model is about to see, and the `step`.

| Option | Values | Default |
| --- | --- | --- |
| `placement` | `turn`: user-side text, for facts about the user or their screen. `system`: a system message, with operator authority. | `turn` |
| `refresh` | `run`: computed once per run. `step`: before every model call. | `run` (`currentTime` uses `step`) |

- Providers come from the kit, plugins (`contextProviders`, or `api.addContext()` in `setup`) and the agent. They run in that order, and the same name overrides an earlier one.
- A provider that throws is skipped, and a `status` event reports `context-error`.
- Context is stored in the run's message at the point the model sees it (an `ai-kit.context` data part, hidden from UIs) and is only added again when its text changes. The system prompt never carries context, and earlier turns go out the same on every request, so the prompt cache stays warm and Claude's thinking stays valid. Drivers without mid-conversation system messages get `system` context as user text.

### Context from the browser

The browser can send what it knows with each message: the current route, a selection, the document that's open.

```ts
const chat = useChat({ getContext: () => ({ route: location.pathname, selection: editor.selectedText() }) })
chat.send("Explain this", { context: { selection: "..." } })   // per message, merged over getContext()
```

On the server it arrives as `clientContext`. It's untrusted, so it never mixes with your `context`. The model only sees it if the agent has the `clientContext()` provider, which labels it as user input and can `pick` keys. Tools and hooks can read `ctx.clientContext` too. The server limits it to 16 KB; set `createHandler(kit, { clientContext: { maxBytes, transform } })` to reshape or drop it per user, or `false` to ignore it.

## Context usage

Every model call reports how full the context window is. A `context-usage` event goes out before the call (an estimate) and after it (the provider's count):

```ts
{
  type: "context-usage",
  step: 0,
  tokens: 2919,
  window: 1_000_000,
  ratio: 0.003,
  source: "estimate" | "provider",
  compactAt: 0.8,                 // when compaction starts; absent when compaction is off
  breakdown: { system: 812, tools: 640, messages: 1429, context: [{ name: "user", tokens: 38 }], output: 0 },
}
```

- The breakdown's sections don't overlap and add up to `tokens`. `messages` leaves out context, `context` counts every copy of a provider's text still in the history (a board stored on each turn it changed counts each time), and `output` is the reply.
- Estimates count about four characters per token. Provider counts are input (cached or not) plus output, and their breakdown is the estimate scaled to the measured prompt, so it stays consistent with the total.
- The latest reading is also stored on the assistant message (`message.contextUsage`). `Chat` exposes it as `state.contextUsage`, and `contextUsageOf(messages)` finds it.
- The window comes from `compaction.contextWindow`, then the driver (`capabilities.contextWindow`), then a table by model id (Claude models built in; add others with `createKit({ contextWindows: { "acme-": 128_000 } })`), and finally 200 000.

Every tool definition, instruction and old tool output costs tokens on every call. These four features keep the context small without taking capabilities away.

## Progressive tool disclosure

Mark tools or whole toolkits `defer: true`. They're left out of the tool list, and the agent gets `search_tools`:

```ts
const github = toolkit({ name: "github", description: "Issues, PRs and repos", defer: true, tools: githubTools })
const refund = tool({ name: "issue_refund", description: "...", keywords: ["money back"], defer: true, execute })
```

The system prompt lists deferred toolkits by name and description. `search_tools({ query })` scores tools by name, keywords and description and loads the best matches. `{ toolkit: "github" }` loads a toolkit, and `{ names: [...] }` loads tools by name. Loaded tools stay loaded for the session (`state["ai-kit.activeTools"]`).

Swap the keyword search for embeddings with `toolSearch: { index: myIndex }`, where `ToolIndex.search(query, entries, limit)` returns hits. MCP toolkits are deferred by default.

Drivers that search tools themselves (`capabilities.toolSearch`, which `claude()` has) get every tool from the first step, with deferred ones marked `defer: true`, and no `search_tools`. The model loads deferred tools with the provider's search, so the tool list never changes mid-conversation. Skill tools are declared the same way.

## Code mode

```ts
defineAgent({ ..., codeMode: { sandbox: workerSandbox() } })
```

The model sees one tool, `run_code`, whose description is a TypeScript declaration of your tools:

```ts
declare const tools: {
  /** Find orders for a customer */
  list_orders(input: { customerId: string; status?: "open" | "shipped" }): Promise<any>
  /** Refund an order */
  refund_order(input: { orderId: string; amount: number }): Promise<any>
  /** Find more tools by what they do. Returns their TypeScript signatures. */
  $search(query: string): Promise<string>
}
```

It writes one script instead of making many round trips:

```js
const orders = await tools.list_orders({ customerId: "c42", status: "open" })
const late = orders.filter((o) => daysSince(o.created) > 30)
for (const o of late) await tools.refund_order({ orderId: o.id, amount: o.total })
return { refunded: late.length }
```

Only the returned value and `console.log` output reach the context. Each `tools.x()` call still goes through validation, hooks, permissions and approvals (code mode always waits for approvals in memory), and shows up as a nested tool call under `run_code`.

Sandboxes:

- `workerSandbox()` (node package): a worker thread with a fresh V8 context, no `require`, `process`, `eval`, filesystem or network, a heap cap, and a kill on timeout. It contains mistakes well. For code from untrusted users, use a stronger boundary.
- `unsafeFunctionSandbox()` (core, the default): runs in-process. For local development only.
- Your own: implement `Sandbox.execute(code, env)` on a container, Firecracker, Deno Deploy or a Cloudflare Worker Loader. Expose `env.tools` over RPC.

Options: `filter` decides which tools go in code mode, `keepDirectTools` also keeps them as normal tools, plus `timeoutMs` and `maxOutputChars`. Tools with `codeMode: false`, client tools and provider tools stay direct.

## Skills

A skill is instructions the agent loads only when a task calls for it. Use the [Agent Skills](https://agentskills.io) folder format, or define skills in code:

```
skills/refunds/SKILL.md      ---\nname: refunds\ndescription: Use for refund requests...\n---\n# Refunds\n...
skills/refunds/policy.md     loaded on demand with read_skill_file
```

```ts
skills: await loadSkills("./skills"),            // node
skills: [defineSkill({ name, description, instructions, files, tools })],  // anywhere
```

The system prompt lists each skill's name and description. `load_skill` returns the body and the list of files. `read_skill_file` reads a file. Tools attached to a skill become available once it's loaded, so skills double as on-demand capability packs. Loaded skills stay loaded for the session.

## Compaction

Drivers that manage context on the provider's side (`capabilities.contextManagement`, which `claude()` has) do both of these themselves: ai-kit leaves the history alone and passes `threshold` × the window and `prompt` to the driver. `claude()` uses the API's server-side compaction; see [drivers](drivers.md).

Otherwise, two layers, cheapest first:

1. **Clearing tool output** (on by default). Tool outputs over 4 000 characters in all but the last 3 assistant messages are replaced with a short note. Tune with `compaction: { clearToolResults: { keepRecent, minChars } }`.
2. **Summarising.** When the request reaches `threshold` (0.8) of `contextWindow`, older messages are summarised. The last `keepRecent` (6) stay word for word. The summary is stored in session state and stands in for those messages on every later call, while the UI keeps the full history.

```ts
compaction: { contextWindow: 200_000, threshold: 0.8, keepRecent: 6, model: claude("claude-haiku-5-5") }
```

`beforeCompact` hooks can veto it, and `session.compact()` runs it on demand. Reasoning in the turns kept after a summary isn't sent again: its signatures cover the full history, which the model no longer sees.

## Memory across sessions

`memoryTool(kv, { namespace })` gives the agent a `/memories` folder it reads at the start of a task and writes to as it learns. Scope it per user with `namespace`. It's the same command set as Anthropic's memory tool, and it's stored in any KV.
