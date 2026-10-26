# Frontend

ai-kit is headless. Use `@alexandernygard/components` (or anything else) for the visuals; ai-kit gives you state, events and grouping.

## The Chat controller

`Chat` (client package) holds one session's state and does the work a chat UI needs:

- sends optimistically and creates the session on the first message
- streams, and reconnects from the last `seq` if the connection drops
- joins a run already in progress when you open a session
- answers approvals and client tools: live runs get `respond`, suspended ones are batched and resumed once
- runs `clientTools` as soon as the agent calls them
- regenerates, edits, switches branches (`versions()` for "2 / 3"), forks

```ts
const chat = new Chat({ transport: httpTransport({ baseUrl: "/api/ai" }), newSession: { agent: "support" } })
chat.subscribe((state) => render(state))   // { sessionId, session, messages, headId, path, status, error, runId, pending }
await chat.send("Hello")
```

`status` is `idle`, `loading`, `submitted`, `streaming`, `awaiting-input` or `error`. `pending` holds the tool calls waiting on the user. `contextUsage` is the latest context-window reading, for a "62% of context" meter.

Pass `getContext: () => ({ route, selection })` to send what the app knows with every message (see [context providers](context.md#context-from-the-browser)), and `send(text, { context })` to add to it for one message.

## React

```tsx
<AIKitProvider baseUrl="/api/ai">...</AIKitProvider>

const chat = useChat({ sessionId, newSession: { agent: "support" }, onSessionCreated: (s) => navigate(`/c/${s.id}`), clientTools })
const { sessions, create, rename, remove, loadMore } = useSessions()
const { agents } = useAgents()
```

`useChat` returns the state plus `send`, `stop`, `approve`, `deny`, `submitToolOutput`, `regenerate`, `edit`, `switchBranch`, `versions`, `fork`, `reset` and `isRunning`. Change `sessionId` to switch sessions, or set it to `undefined` for a new chat.

## Svelte

`Chat` follows the Svelte store contract, so it works with `$`:

```svelte
<script lang="ts">
  import { Chat, httpTransport } from "@alexandernygard/ai-kit-client"
  const chat = new Chat({ transport: httpTransport(), newSession: { agent: "support" } })
</script>

{#each $chat.path as message (message.id)}
  <MessageView {message} />
{/each}
<Composer busy={$chat.status === "streaming"} onsubmit={(text) => chat.send(text)} />
```

## Rendering messages

`segments(message)` groups parts the way chat UIs show them:

- `text` and `reasoning` blocks
- `tools`: consecutive tool calls as one group for a trace, with code-mode calls nested in `children` and a subagent's live message on `child`
- `file` and `data` parts (`data` is for your own `ctx.emit` UIs, plus `todos`)

`MessageParts` in the React package is a headless renderer on top of it, with a per-tool-name escape hatch:

```tsx
<MessageParts message={m} render={{
  text: (p) => <Bubble variant="ghost"><BubbleContent>{p.text}</BubbleContent></Bubble>,
  reasoning: (p) => <ThoughtTrace text={p.text} />,
  tools: (tools) => <ToolTrace tools={tools} />,
  tool: { ask_user: (t) => <AskUser call={t} />, get_weather: (t) => <WeatherCard data={t.output} /> },
  data: { chart: (p) => <Chart spec={p.data} /> },
}} />
```

Helpers: `toolLabel(t)` ("Booking DY612 (needs approval)"), `isToolActive(t)`, `toolDuration(t)`, `todosOf(path)`, `sourcesOf(message)`.

## Patterns with @alexandernygard/components

[examples/react-chat](../examples/react-chat/src/App.tsx) has all of these working:

| Pattern | Components | ai-kit |
| --- | --- | --- |
| Message list that sticks to the bottom | `MessageScroller*`, `Message`, `Bubble` | `chat.path` |
| "Thinking" before the first token | `Marker` + `Spinner` with `shimmer` | `chat.isRunning` and the last message has no parts |
| Tool activity | `Trace`, `TraceLine status="running" \| "error"`, `TraceCollapsible` + `CodeBlock` for input and output | `segments()` tools, `toolLabel`, `toolDuration`, `isToolActive` |
| Code mode | nested `Trace` under the `run_code` line | `ToolNode.children` |
| Subagents | a `Trace` line with the child's text | `ToolNode.child` (`nestSubagents`) |
| Reasoning | `TraceCollapsible` "Thought" | `reasoning` segments |
| Approval | `Card` with `CodeBlock` input, Approve / Always allow / Deny | `t.state === "awaiting-approval"`, `approve`, `deny` |
| Ask the user | `Questionnaire` with choices and a free-text `QuestionnaireInput` | `ask_user` input, `submitToolOutput(id, { answers })` |
| Task list | a checklist above the composer | `todosOf(chat.path)` |
| Context meter | `Progress` and a token count, breakdown in a tooltip | `chat.contextUsage` |
| Composer with stop | `InputGroup`, `InputGroupTextarea`, `InputGroupButton` | `send`, `stop`, `isRunning` |
| Versions | ghost icon buttons and "2 / 3" | `versions(id)`, `switchBranch` |
| Regenerate, fork | icon buttons in `MessageFooter` | `regenerate(id)`, `fork(id)` |
| Session sidebar | buttons or `Sidebar` | `useSessions()` |
| Attachments | `Attachment` | `composeParts(text, files)` |

If a pattern keeps coming back, build it in the component library (for example a `ToolTrace` or `ApprovalCard` that takes plain props) and keep ai-kit headless.

## Running the kit in the browser

The whole kit can run in the page, with no server. Apps where each user brings their own Anthropic API key (a document editor, a spreadsheet, a local-first tool) use this, as do Electron apps and tests.

```ts
import { defineAgent, sourceTools } from "@alexandernygard/ai-kit"
import { claudeFromSettings } from "@alexandernygard/ai-kit-anthropic"
import { type AssistantSettings, createBrowserKit, settingsStore } from "@alexandernygard/ai-kit-react"

export const settings = settingsStore<AssistantSettings>({ model: "claude-opus-5-5", effort: "medium" }, { key: "myapp:settings" })

const editor = defineAgent({
  name: "editor",
  model: claudeFromSettings(settings.get),
  tools: sourceTools({ files, feedback: ({ after }) => validate(after) }),
})

export const { kit, transport } = createBrowserKit({ agents: [editor], database: "myapp" })
```

- `createBrowserKit` stores sessions in IndexedDB (in memory where IndexedDB isn't available) and returns a `directTransport`, so `Chat`, `useChat` and `useAssistant` work exactly as they do against a server. Pass `store` to use another store, and `transport` for `directTransport` options such as `context`.
- `settingsStore` keeps the key, model and effort in localStorage. `useSettings(settings)` returns `[settings, set]` for a settings panel.
- `claudeFromSettings` reads the settings on every call, so a new key or model takes effect immediately. It calls the Claude API from the browser (`dangerouslyAllowBrowser`), and fails the run with "Add your Anthropic API key in settings." when there's no key.
- Tools run in the page, so `execute` can read and change app state directly. Client tools are only needed when the agent runs on a server.

For an assistant beside a document, `useAssistant` keeps one conversation per document:

```tsx
const chat = useAssistant({ transport, documentId: doc.id, getContext: () => ({ documentId: doc.id }) })
const [s, set] = useSettings(settings)
```

It stores `documentId` in the session's metadata, reopens the newest session for that document (`findDocumentSession`), and switches conversations when `documentId` changes. While it looks, `status` is `loading`.

`toolInput(part)` returns a tool call's input while it streams, parsed from partial JSON, so the document can show a `write_file` as it's written.

[examples/browser-editor](../examples/browser-editor) has all of this working.
