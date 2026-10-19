# Server

`createHandler(kit, options)` returns `(req: Request, extras?) => Promise<Response>`, which fits any server built on Web requests.

```ts
const handler = createHandler(kit, {
  basePath: "/api/ai",
  auth: async (req) => {
    const user = await userFromCookie(req)
    return user ? { userId: user.id, context: { user, db } } : null   // null → 401
  },
  agents: ["support", "concierge"],          // which agents clients may use
  runOptions: ({ auth }) => ({ permissionMode: auth.context.user.admin ? "default" : "ask", limits: { maxCostUsd: 1 } }),
  cors: ["https://app.example.com"],
})
```

Sessions are owned by `userId`. Every route checks ownership, and another user's session answers 404. Clients can't set permissions, limits or context; those come from `auth` and `runOptions`.

## Mounting

```ts
// Hono (Node, Bun, Workers)
app.all("/api/ai/*", (c) => handler(c.req.raw, { waitUntil: (p) => c.executionCtx.waitUntil(p) }))

// Next.js: app/api/ai/[...path]/route.ts
export const { GET, POST, PATCH, DELETE, OPTIONS } = nextHandlers(handler)

// SvelteKit: src/routes/api/ai/[...path]/+server.ts
export const fallback: RequestHandler = ({ request }) => handler(request)

// Cloudflare Workers
export default { fetch: (req, env, ctx) => handler(req, { waitUntil: (p) => ctx.waitUntil(p) }) }

// node:http or Express (node package)
http.createServer(toNodeHandler(handler)).listen(3000)
```

Runs keep going when a client disconnects. On platforms that stop work when the response ends, pass `waitUntil` so the run can finish, and use a store with an event log so the client can catch up.

## Routes

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| GET | `/agents` | | `{ agents }` with commands |
| GET | `/sessions?agent&parent&limit&cursor` | | `{ sessions, nextCursor }` |
| POST | `/sessions` | `{ agent?, title?, metadata? }` | session |
| GET | `/sessions/:id` | | `{ session, messages }` (all branches) |
| PATCH | `/sessions/:id` | `{ title?, metadata? }` | session |
| DELETE | `/sessions/:id` | | 204 |
| GET | `/sessions/:id/children` | | `{ sessions }` (subagents) |
| POST | `/sessions/:id/messages` | `{ content, parentId?, editOf?, agent?, interrupt? }` | event stream |
| POST | `/sessions/:id/resume` | `{ responses: { [toolCallId]: response } }` | event stream |
| POST | `/sessions/:id/respond` | `{ toolCallId, response }` | `{ live: true }` if a run took it, else event stream |
| POST | `/sessions/:id/regenerate` | `{ messageId? }` | event stream |
| POST | `/sessions/:id/fork` | `{ messageId?, title? }` | `{ session, messages }` |
| POST | `/sessions/:id/branch` | `{ messageId }` | `{ session, messages }` |
| POST | `/sessions/:id/compact` | | `{ summary }` |
| POST | `/sessions/:id/abort` | | `{ ok }` |
| GET | `/runs/:runId/events?session&after` | | event stream (honours `Last-Event-ID`) |
| POST | `/runs/:runId/abort` | | `{ ok }` |

Event streams are server-sent events. Each `data:` line is `{ seq, runId, event }`, and the response carries `x-run-id` and `x-session-id` headers. A keep-alive comment goes out every 15 seconds.

## Exposing tools over MCP

The same tools can serve Claude Desktop, Cursor or another agent:

```ts
import { createMcpServer, mcpHttpHandler } from "@alexandernygard/ai-kit-mcp"
app.all("/mcp", (c) => mcpHttpHandler(() => createMcpServer([lookupOrder, refund]), { authorize: checkToken })(c.req.raw))
```
