# Sessions, branches, forks and storage

## Sessions

```ts
const session = await kit.createSession({ agent: "support", ownerId: user.id, title, metadata })
const again = await kit.getSession(id)
const { sessions, nextCursor } = await kit.listSessions({ ownerId: user.id, limit: 20 })
await session.update({ title: "Refund for A1" })
await session.delete()   // and its subagent sessions
```

Titles default to the start of the first message. `createKit({ title: claude("claude-haiku-5-5") })` writes them with a model instead, and `title: false` turns titles off.

## Runs

```ts
const run = session.send("Hi", { context, permissionMode: "plan", limits: { maxSteps: 5 } })
for await (const e of run) {}            // AgentEvent
const r = await run.result               // { text, message, output, usage, finishReason, pending, error }
run.abort()
run.respond(toolCallId, { approved: true })
```

One run at a time per session. `send(..., { interrupt: true })` stops the current one first. `send` can also take parts with files: `[filePart({ mediaType: "image/png", data }), textPart("What's this?")]`.

`finishReason` is one of:

- `stop`: the agent finished.
- `awaiting-input`: approvals or client tools are pending; call `resume`.
- `max-steps`, `budget`, `length`: a limit was hit.
- `aborted`, `error`, `content-filter`.

`kit.generate(content, { agent, output })` is a one-off run in a temporary session that's deleted afterwards.

## Branches

Messages form a tree. The session's `headId` picks the active branch.

```ts
await session.edit(userMessageId, "Actually, Bergen")   // new sibling user message, new answer
await session.regenerate()                              // new sibling answer to the last question
await session.versions(messageId)                       // siblings, oldest first
await session.switchBranch(messageId)                   // head moves to that branch's newest leaf
await session.history()                                 // the active branch
await session.messages()                                // everything
```

`send(content, { parentId })` replies to any message and so starts a branch there.

## Forks

```ts
const copy = await session.fork({ messageId, title: "Try the cheaper plan" })
```

The new session gets copies of the messages up to `messageId` (the head by default), with new ids. `forkedFrom` records where it came from. Session state comes along, except the compaction summary.

## Subagent sessions

Each `task` call creates a child session with `parentSessionId` and `parentToolCallId`. `session.children()` lists them, and they open like any other session. Listing only returns top-level sessions unless you pass `parentSessionId`.

## Session state

Tools write `ctx.state.set(key, value)`; your code writes `session.setState(key, value)`. Keys ai-kit uses:

| Key | What |
| --- | --- |
| `ai-kit.activeTools` | tools loaded by search |
| `ai-kit.loadedSkills` | skills loaded |
| `ai-kit.allowedTools` | "always allow" approvals |
| `ai-kit.todos` | the agent's task list |
| `ai-kit.compaction` | summary and where it ends |

## Stores

```ts
memoryStore()                                       // tests, browser
kvStore(kv)                                         // any { get, set, delete, list }
sqlStore({ exec, dialect: "sqlite" | "postgres" })  // run store.migrate() once, or sqlSchema() in your migrations
fileStore(".ai-kit")                                // node package
```

`sqlStore` executors:

```ts
// better-sqlite3 / node:sqlite
sqlStore({ exec: async (sql, p) => db.prepare(sql).all(...p) })
// Cloudflare D1
sqlStore({ exec: async (sql, p) => (await env.DB.prepare(sql).bind(...p).all()).results })
// postgres.js
sqlStore({ dialect: "postgres", exec: (sql, p) => pg.unsafe(sql, p) })
```

Or implement `Store` yourself: eight methods, plus two optional ones. The optional `appendEvents` and `readEvents` log a run's events so clients can reconnect to it, even from another server instance, once the run has written them.

## Reconnecting

Every event has a `seq`. Clients reconnect with `GET /runs/:runId/events?after=<seq>&session=<id>`, which reads live from memory, or from the store's event log when the run is elsewhere or finished. `Chat` does this on its own when a stream drops, and when you open a session that has a run in progress.

A stream that closes without `run-finish` counts as a drop too. If reconnecting doesn't bring the run back, `Chat` checks the session until it no longer names the run as active, then shows what's stored.

## Runs that die

A run holds a lease on its session (`activeRunLeaseUntil`) and renews it while it's alive. If its process crashes, restarts or the page reloads, the lease lapses (`runLeaseMs`, 15 seconds by default). The next time anything loads the session, ai-kit ends the run: tool calls that never got a result fail with "Interrupted.", the message becomes `aborted`, and the session can take new messages again. Calls that were waiting on approvals or client tools stay pending, so the session can be resumed. Sending to a session whose run is alive in another process fails rather than interrupting it.
