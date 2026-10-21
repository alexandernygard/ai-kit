# ai-kit

A TypeScript toolkit for building AI apps on the server and in the browser. You define agents with tools, skills and subagents. ai-kit runs them in sessions you can branch and fork, streams every step to your UI, and pauses for approvals or browser-side tools. Agents run on the Claude API through the official Anthropic SDK, or on any other provider through the AI SDK.

```ts
import { createKit, defineAgent, tool } from "@alexandernygard/ai-kit"
import { claude } from "@alexandernygard/ai-kit-anthropic"
import { z } from "zod"

const support = defineAgent({
  name: "support",
  instructions: "You help customers with their orders.",
  model: claude("claude-opus-5-5"),
  tools: [
    tool({
      name: "lookup_order",
      description: "Find an order by id",
      input: z.object({ id: z.string() }),
      readOnly: true,
      execute: ({ id }) => db.orders.find(id),
    }),
  ],
})

const kit = createKit({ agents: [support] })
const session = await kit.createSession({ ownerId: user.id })
for await (const event of session.send("Where is order A1?")) {
  if (event.type === "text-delta") process.stdout.write(event.delta)
}
```

## Packages

| Package | What it does | Runs in |
| --- | --- | --- |
| [`@alexandernygard/ai-kit`](packages/core) | Agents, tools, sessions, branches, forks, runner, approvals, permissions, hooks, skills, tool search, code mode, subagents, compaction, plugins, stores, event protocol | anywhere |
| [`@alexandernygard/ai-kit-anthropic`](packages/anthropic) | Driver for the Claude API through `@anthropic-ai/sdk`: caching, thinking, server tools, structured output | anywhere |
| [`@alexandernygard/ai-kit-ai-sdk`](packages/ai-sdk) | Driver for any [AI SDK](https://ai-sdk.dev) model: OpenAI, Google, AI Gateway... | anywhere |
| [`@alexandernygard/ai-kit-mcp`](packages/mcp) | MCP servers as toolkits; ai-kit tools as an MCP server | anywhere (stdio: Node) |
| [`@alexandernygard/ai-kit-server`](packages/server) | The HTTP API as one fetch handler: Hono, Next.js, SvelteKit, Workers, Bun, Node | server |
| [`@alexandernygard/ai-kit-client`](packages/client) | Typed client, streaming with reconnects, the `Chat` controller (a Svelte store too), part grouping | browser |
| [`@alexandernygard/ai-kit-react`](packages/react) | `useChat`, `useSessions`, `useAgents`, headless `MessageParts` | browser |
| [`@alexandernygard/ai-kit-node`](packages/node) | File store, SKILL.md loader, worker sandbox for code mode, file and shell tools, `node:http` adapter | Node |

UI components live in [`@alexandernygard/components`](../component-library): `Message`, `Bubble`, `Trace`, `Questionnaire`, `MessageScroller` and the rest. ai-kit stays headless; [examples/react-chat](examples/react-chat) shows the two together.

## Features

**Models** ([docs/drivers.md](docs/drivers.md))
- A driver makes one model call and ai-kit runs the loop, so every feature works with every driver. `claude()` calls the Claude API directly; `aiSdk()` covers the other providers.
- Fallback models, effort levels, prompt caching on Anthropic, and a cost table for usage reports.

**Agents and tools** ([docs/agents.md](docs/agents.md))
- Tools from zod or JSON Schema. Async-generator tools report progress. Each tool can have a timeout, a title for UIs, examples and a custom model output.
- Client tools run in the browser (geolocation, file pickers, forms), and the run pauses until they answer.
- Approvals: per tool, by rule (`bash(git *)`), by hook, or by mode (`default`, `ask`, `plan`, `auto`). "Always allow" is remembered for the session.
- Two ways to wait for input: `suspend` ends the run and resumes later (serverless-friendly), `wait` holds it in memory.
- Hooks for every stage: user message, model call, before and after each tool, stop (keep going), compaction, subagents, events.
- Structured output with any schema, through native JSON mode or a tool.
- Built-ins: `ask_user` (multiple-choice questions), `todo_write` (a live checklist), `memory` (notes that persist across sessions).

**Context** ([docs/context.md](docs/context.md))
- Context providers attach live information to every call: the user, the time, what's on screen (`getContext` in the browser, kept separate as untrusted).
- Context usage: every call reports tokens against the model's window, with a breakdown, for a "62% of context" meter.
- Progressive tool disclosure: deferred tools and toolkits stay out of the prompt until `search_tools` (or Claude's server-side tool search) finds them.
- Code mode: tools become typed functions inside one `run_code` tool. The agent writes a script that loops and filters, and intermediate data never reaches the context. Runs in a worker sandbox.
- Skills in the Agent Skills format (SKILL.md folders). Only names and descriptions sit in the prompt; the body, files and tools load on demand.
- Compaction: old tool outputs are trimmed first, then older turns are summarised as the context window fills.

**Sessions and data** ([docs/sessions.md](docs/sessions.md))
- Messages form a tree: editing or regenerating creates a branch, and `versions()` and `switchBranch()` drive the "2 / 3" arrows.
- `fork()` copies a conversation into a new session.
- Subagents run in child sessions you can open and inspect.
- Stores: memory, any KV (Workers KV, Redis, IndexedDB), SQL (SQLite, D1, Postgres) and files. Each run's events are stored so clients can reconnect mid-run.
- Slash commands, plugins, workflows (`chain`, `parallel`, `route`, `evaluateLoop`).

**Frontend** ([docs/frontend.md](docs/frontend.md))
- `Chat` holds streaming state, optimistic sends, batched approvals, client tools, reconnects, branches and forks. It follows the Svelte store contract and works with React's `useSyncExternalStore`.
- `segments()` groups parts for rendering: text, reasoning, tool traces with code-mode calls nested, files and data.
- `directTransport(kit)` runs the same UI against an in-process kit, for local-first apps, Electron and tests.

## Get started

```bash
pnpm add @alexandernygard/ai-kit @alexandernygard/ai-kit-server @alexandernygard/ai-kit-react
pnpm add @alexandernygard/ai-kit-anthropic @anthropic-ai/sdk   # Claude API
# or: pnpm add @alexandernygard/ai-kit-ai-sdk ai @ai-sdk/openai  # another provider
```

Server (any framework with Web `Request`/`Response`):

```ts
import { createKit, sqlStore } from "@alexandernygard/ai-kit"
import { createHandler } from "@alexandernygard/ai-kit-server"

const kit = createKit({ agents: [support], store: sqlStore({ exec: (sql, params) => db.query(sql, params) }) })
export const handler = createHandler(kit, {
  auth: async (req) => {
    const user = await getUser(req)
    return user ? { userId: user.id, context: { user } } : null
  },
})
```

React:

```tsx
import { AIKitProvider, MessageParts, useChat } from "@alexandernygard/ai-kit-react"

function Support() {
  const chat = useChat({ newSession: { agent: "support" } })
  return (
    <>
      {chat.path.map((m) => (
        <MessageParts key={m.id} message={m} render={{ text: (p) => <Bubble>{p.text}</Bubble>, tools: (t) => <ToolTrace tools={t} /> }} />
      ))}
      <Composer onSubmit={chat.send} onStop={chat.stop} busy={chat.isRunning} />
    </>
  )
}
```

More in [docs/](docs): [architecture](docs/architecture.md), [drivers](docs/drivers.md), [agents](docs/agents.md), [context](docs/context.md), [sessions](docs/sessions.md), [server](docs/server.md), [frontend](docs/frontend.md), [plugins and MCP](docs/plugins.md), [feature map](docs/feature-map.md).

## Examples

- [examples/react-chat](examples/react-chat): a travel concierge with sessions, approvals, ask-user questionnaires, a client tool, a deferred toolkit, a skill, a subagent and todos, built with `@alexandernygard/components`. `pnpm --filter example-react-chat dev`.
- [examples/node-cli](examples/node-cli): a one-turn tool-calling smoke test against the Claude API. `pnpm --filter example-node-cli smoke`.

## Develop

```bash
pnpm install
pnpm test        # vitest, all packages
pnpm typecheck   # every package plus the tests
pnpm build       # tsdown, every package
```

Packages resolve each other's source through the `ai-kit-source` export condition, so tests and typechecks need no build. Releases use Changesets, as in the component library: `pnpm changeset`, then `pnpm version-packages` and `pnpm release`.
