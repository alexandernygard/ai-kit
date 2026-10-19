# Context: tool search, code mode, skills, compaction

Every tool definition, instruction and old tool output costs tokens on every call. These four features keep the context small without taking capabilities away.

## Progressive tool disclosure

Mark tools or whole toolkits `defer: true`. They're left out of the tool list, and the agent gets `search_tools`:

```ts
const github = toolkit({ name: "github", description: "Issues, PRs and repos", defer: true, tools: githubTools })
const refund = tool({ name: "issue_refund", description: "...", keywords: ["money back"], defer: true, execute })
```

The system prompt lists deferred toolkits by name and description. `search_tools({ query })` scores tools by name, keywords and description and loads the best matches. `{ toolkit: "github" }` loads a toolkit, and `{ names: [...] }` loads tools by name. Loaded tools stay loaded for the session (`state["ai-kit.activeTools"]`).

Swap the keyword search for embeddings with `toolSearch: { index: myIndex }`, where `ToolIndex.search(query, entries, limit)` returns hits. MCP toolkits are deferred by default.

With harness drivers every tool is bridged up front, because a harness takes its tool list once per run. Claude Code and Codex then defer large MCP tool sets with their own search.

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

Two layers, cheapest first:

1. **Clearing tool output** (always on). Tool outputs over 4 000 characters in all but the last 3 assistant messages are replaced with a short note. Tune with `compaction: { clearToolResults: { keepRecent, minChars } }`.
2. **Summarising.** When the request reaches `threshold` (0.8) of `contextWindow`, older messages are summarised. The last `keepRecent` (6) stay word for word. The summary is stored in session state and stands in for those messages on every later call, while the UI keeps the full history.

```ts
compaction: { contextWindow: 200_000, threshold: 0.8, keepRecent: 6, model: aiSdk(anthropic("claude-haiku-5-5")) }
```

`beforeCompact` hooks can veto it, and `session.compact()` runs it on demand. Harness drivers use their own compaction.

## Memory across sessions

`memoryTool(kv, { namespace })` gives the agent a `/memories` folder it reads at the start of a task and writes to as it learns. Scope it per user with `namespace`. It's the same command set as Anthropic's memory tool, and it's stored in any KV.
