---
name: ai-kit
description: |
  How to build AI features with Alex's ai-kit: the @alexandernygard/ai-kit packages (core, -anthropic,
  -ai-sdk, -server, -client, -react, -node, -mcp; repo ~/MyStuff/Projects/ai-kit, github.com/alexandernygard/ai-kit).
  Use when adding an assistant, chat, agent, copilot or "AI" feature to one of Alex's apps, wiring Claude
  into an app, defining agents, tools, approvals, skills or subagents, streaming agent output to a UI,
  serving agents over HTTP, building a browser-only app that uses the user's own API key, or when the
  user mentions "ai-kit", "the ai kit" or "@alexandernygard/ai-kit". Prefer it over calling the
  Anthropic SDK or Vercel AI SDK directly in those apps.
---

# ai-kit

A TypeScript runtime for agents. You define agents with tools; ai-kit runs the loop, keeps sessions (a branchable message tree), streams every step as events, pauses for approvals and browser-side tools, and renders headless state for the UI. Visuals come from `@alexandernygard/components` (see the `alexandernygard-components` skill).

The docs in the repo are the reference: `docs/agents.md`, `context.md`, `sessions.md`, `server.md`, `frontend.md`, `drivers.md`, `plugins.md`. Working apps: `examples/browser-editor` (browser-only, per-document assistant), `examples/react-chat` (server + React, every UI pattern), `examples/node-cli`.

## Pick a shape first

| App | Packages | Model call from |
| --- | --- | --- |
| **Browser-only** (no backend; user pastes their key) | `ai-kit`, `ai-kit-anthropic`, `ai-kit-react` | the page, `claudeFromSettings` |
| **Server + browser** (app has a backend, key stays secret) | server: `ai-kit`, `ai-kit-anthropic`, `ai-kit-server`; browser: `ai-kit-react` (or `ai-kit-client` for Svelte) | the server, `claude()` |
| **Node script / CLI / job** | `ai-kit`, `ai-kit-anthropic`, `ai-kit-node` | Node |

All three produce the same events, so the UI code is the same whichever transport it gets.

```bash
pnpm add @alexandernygard/ai-kit @alexandernygard/ai-kit-anthropic @anthropic-ai/sdk zod
pnpm add @alexandernygard/ai-kit-react            # React UI (re-exports ai-kit-client)
pnpm add @alexandernygard/ai-kit-server           # only with a backend
```

`@anthropic-ai/sdk` and `react` are peers. If the app's `pnpm-workspace.yaml` sets `minimumReleaseAge`, add `'@alexandernygard/*'` to `minimumReleaseAgeExclude`. Default model: `claude-opus-5-5`; `claude-haiku-5-5` for cheap side jobs (titles, summaries).

## Agents and tools

```ts
import { defineAgent, tool, toolkit } from "@alexandernygard/ai-kit"
import { claude } from "@alexandernygard/ai-kit-anthropic"
import { z } from "zod"

const lookupOrder = tool({
  name: "lookup_order",
  description: "Find an order by id",                // the model reads this: say when to use it
  input: z.object({ id: z.string() }),               // zod, any Standard Schema, or jsonSchema(...)
  readOnly: true,
  execute: ({ id }, ctx) => db.orders.find(id),      // value, promise, or async generator (yield = progress)
})

const refund = tool({
  name: "refund_order",
  description: "Refund an order",
  input: z.object({ orderId: z.string(), amount: z.number() }),
  needsApproval: (i) => i.amount > 500,              // or true; the run pauses for the user
  title: (i) => `Refunding ${i.amount} kr`,          // label in the UI
  execute: async (i, ctx) => payments.refund(i.orderId, i.amount, { signal: ctx.signal }),
})

export const support = defineAgent({
  name: "support",
  instructions: ({ context }) => `You help ${context.user.name} with orders.`,
  model: claude("claude-opus-5-5"),
  settings: { effort: "medium" },
  tools: [lookupOrder, refund],
  limits: { maxSteps: 25, maxCostUsd: 0.5 },
  builtins: { askUser: true, todos: true },          // multiple-choice questions, a live checklist
})
```

- `ctx` (ToolContext): `signal`, `context` (trusted, from the server or `send`), `clientContext` (untrusted, from the browser), `state` (session-scoped KV), `progress()`, `emit()` (custom data part for the UI), `callTool()`.
- Throwing in `execute` returns the message to the model as an error so it can recover. Write error messages the model can act on.
- `toModelOutput` shapes what the model sees (text, JSON, or content with images); the UI still gets the full output.
- Many tools: group them with `toolkit({ name, description, tools, defer: true })`; deferred tools load through Claude's server-side tool search.
- Other agent options: `subagents` (gives a `task` tool), `skills` (`defineSkill` or `loadSkills("./skills")` in Node), `contextProviders`, `hooks`, `permissions` (`mode: "default" | "ask" | "plan" | "auto"`, glob rules like `"bash(git *)"`), `codeMode`, `compaction`, `fallbackModels`. See `docs/agents.md` and `docs/context.md`.
- Live context each turn (open document, selection, user, time): `contextProviders: [defineContext({ name, get, refresh: "step" }), currentTime(), clientContext({ pick: ["route"] })]`. Don't rebuild `instructions` per turn; that breaks the prompt cache.

## Editing a document: `sourceTools`

For an assistant that changes text the app owns (a JSON doc, code, markdown, a spreadsheet's source):

```ts
import { sourceTools, type SourceFiles } from "@alexandernygard/ai-kit"

tools: sourceTools({
  files: (ctx): SourceFiles => ({                      // or a fixed SourceFiles; memoryFiles(initial) for tests
    read: (path) => docs.get(String(ctx.clientContext?.documentId))?.text,
    write: (path, text) => docs.update(String(ctx.clientContext?.documentId), text),
  }),
  defaultPath: "document.json",
  checkPath: (p) => (p === "document.json" ? undefined : "There is one file: document.json."),
  feedback: ({ after }) => validate(after),           // appended to every edit result: the self-check loop
})
```

The model gets `read_file`, `edit_file` (exact unique match, clear errors when it isn't) and `write_file`. Always add a `feedback` check (parse, lint, recalc) so the model sees whether its edit broke something and fixes it in the same run.

## Browser-only apps

```ts
// assistant.ts
import { claudeFromSettings } from "@alexandernygard/ai-kit-anthropic"
import { type AssistantSettings, createBrowserKit, settingsStore } from "@alexandernygard/ai-kit-react"

export const settings = settingsStore<AssistantSettings>({ model: "claude-opus-5-5", effort: "medium" }, { key: "myapp:settings" })

const editor = defineAgent({ name: "editor", model: claudeFromSettings(settings.get), tools: [...], contextProviders: [...] })

export const { kit, transport } = createBrowserKit({ agents: [editor], database: "myapp" })   // sessions in IndexedDB
```

```tsx
// App.tsx
const chat = useAssistant({ transport, documentId: doc.id, getContext: () => ({ documentId: doc.id }) })
const [s, set] = useSettings(settings)   // key / model / effort panel: set({ apiKey })
```

- `claudeFromSettings` reads key, model and effort on every call, so the settings panel takes effect immediately. With no key it fails the run with "Add your Anthropic API key in settings."
- `useAssistant` keeps one conversation per `documentId` (stored in session metadata) and reopens it when the user comes back.
- Tools here are ordinary tools: `execute` runs in the page and can touch app state directly.
- Tell users the key stays in their browser and goes only to the Claude API.

## Server + browser

```ts
// server: any Web Request/Response framework
import { createKit, sqlStore } from "@alexandernygard/ai-kit"
import { createHandler } from "@alexandernygard/ai-kit-server"

const kit = createKit({ agents: [support], store: sqlStore({ exec: (sql, params) => db.query(sql, params) }) })
export const handler = createHandler(kit, {
  basePath: "/api/ai",
  auth: async (req) => {
    const user = await getUser(req)
    return user ? { userId: user.id, context: { user } } : null   // null → 401; context → ctx.context
  },
})
// Hono: app.all("/api/ai/*", (c) => handler(c.req.raw, { waitUntil: (p) => c.executionCtx.waitUntil(p) }))
// Next: export const { GET, POST, PATCH, DELETE, OPTIONS } = nextHandlers(handler)
// SvelteKit: export const fallback = ({ request }) => handler(request)
// Node: http.createServer(toNodeHandler(handler))   (ai-kit-node)
```

```tsx
<AIKitProvider baseUrl="/api/ai">
  <App />
</AIKitProvider>

const chat = useChat({ sessionId, newSession: { agent: "support" }, onSessionCreated: (s) => navigate(`/c/${s.id}`) })
const { sessions, create, rename, remove } = useSessions()
```

- Sessions are owned by `userId`; clients can't set permissions, limits or `context`. Browser state goes in `getContext()` and arrives as untrusted `clientContext`.
- Streams are SSE with sequence numbers; `Chat` reconnects and resumes from the last event. Runs outlive the request: pass `waitUntil` on Workers and use a store with an event log (`sqlStore`, `kvStore`) so clients can catch up.
- Stores: `memoryStore()` (dev), `kvStore(kv)` (Workers KV, Redis, IndexedDB), `sqlStore({ exec })` (SQLite, D1, Postgres), `fileStore(dir)` (Node).

### Browser-side tools with a server

Declare the tool on the server with no `execute`; implement it in the browser by name:

```ts
tool({ name: "highlight_range", description: "Highlight cells for the user", input: z.object({ range: z.string() }) })
```

```tsx
useChat({ clientTools: { highlight_range: ({ range }) => { grid.highlight(range); return "Done" } } })
```

No handler registered → the call lands in `chat.pending`; render UI for it and answer with `chat.submitToolOutput(id, value)`. The tool name string must match on both sides (nothing checks it).

## Rendering

ai-kit is headless. From `useChat` / `useAssistant`:

- State: `path` (active branch messages), `status` (`idle | loading | submitted | streaming | awaiting-input | error`), `isRunning`, `error`, `pending`, `contextUsage`.
- Actions: `send(text | parts, { context })`, `stop()`, `approve(id, { remember })`, `deny(id, message)`, `submitToolOutput`, `regenerate`, `edit`, `versions`/`switchBranch` ("2 / 3"), `fork`, `reset`.
- Messages have `parts`: `text`, `reasoning`, `tool` (`toolName`, `input`, `output`, `state`: `input-streaming | input-available | awaiting-approval | awaiting-output | running | output-available | output-error | denied`), `file`, `data`.
- Helpers: `segments(message)` groups parts for display (tool runs as one trace, code-mode and subagent calls nested), `<MessageParts render={{ text, reasoning, tools, tool: { name: fn }, data }}>`, `toolLabel(t)`, `isToolActive(t)`, `toolDuration(t)`, `toolInput(t)` (parsed partial input while it streams, for live previews), `todosOf(path)`, `textOf(message)` (core), `composeParts(text, files)`.
- Patterns with components (message scroller, tool traces, approval cards, `Questionnaire` for `ask_user`, context meter, versions): copy from `examples/react-chat/src/App.tsx`.
- Svelte: `new Chat({ transport: httpTransport() })` from `ai-kit-client` is a Svelte store: `$chat.path`.

## Node and one-off calls

```ts
const kit = createKit({ agents: [support] })
const session = await kit.createSession({ agent: "support" })
for await (const e of session.send("Where is A1?", { context: { user } })) if (e.type === "text-delta") process.stdout.write(e.delta)

const { output } = await kit.generate("Extract the invoice", { agent: "extractor", output: z.object({ total: z.number() }) })
```

`run.result` gives `{ text, output, usage, finishReason, pending }`. `finishReason: "awaiting-input"` means approvals or client tools are waiting: answer with `session.resume({ [toolCallId]: { approved: true } })` or pass `onToolApproval` to `send`. `ai-kit-node` adds `fileTools`, `shellTool`, `loadSkills`, `workerSandbox` (code mode) and `fileStore`. MCP servers: `mcpPlugin([{ name, transport: { url } }])` in `plugins`.

## Testing

```ts
import { mockModel } from "@alexandernygard/ai-kit/testing"
```

`mockModel` scripts model turns (text, tool calls) so agent tests run without a key. Test the tools and the `feedback` check directly; use `memoryFiles()` for `sourceTools`. Don't mock ai-kit internals.

## Rules of thumb

- Keep the Claude-specific defaults: prompt caching, adaptive thinking, server-side compaction and tool search are on in `claude()`. Don't put changing data in `instructions`; use context providers.
- Approval on anything destructive or external (`needsApproval`, `destructive: true`); `readOnly: true` on reads so `plan` mode works.
- One agent per job. Reach for `subagents` or `workflows` (`chain`, `parallel`, `route`, `evaluateLoop`) before giant instructions.
- If something you need is missing (a new tool type, a UI helper, a store), add it to ai-kit in `~/MyStuff/Projects/ai-kit` rather than working around it in the app, then release with changesets (`pnpm changeset`, `pnpm changeset version`, `pnpm release`).
