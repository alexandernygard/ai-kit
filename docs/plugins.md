# Plugins and MCP

## Plugins

A plugin packages one capability for an app: tools, skills, agents, commands, hooks, permissions and instructions.

```ts
export const billing = definePlugin({
  name: "billing",
  description: "Invoices and refunds",
  tools: [getInvoice, refundToolkit],
  skills: [refundPolicy],
  commands: [defineCommand({ name: "invoice", description: "Show an invoice", prompt: (id) => `Show invoice ${id}.` })],
  instructions: "Amounts are in NOK, including VAT.",
  permissions: { ask: ["refund_*"] },
  hooks: { afterToolCall: auditLog },
  namespaceTools: true,           // tools become billing__get_invoice
  async setup(api) {              // runs once, when the kit starts
    const plans = await loadPlans()
    api.addInstructions(`Plans: ${plans.join(", ")}`)
  },
})

createKit({ agents, plugins: [billing] })     // every agent
defineAgent({ ..., plugins: [billing] })      // one agent
```

Order: kit settings first, then kit plugins, then agent plugins, then the agent. Hooks all run in that order. For tools, skills and commands with the same name, the later one wins. Permission rules are combined.

Ideas for per-app plugins:

- **Audit:** `onEvent` and `afterToolCall` write to your log.
- **Guardrails:** `onUserMessage` blocks secrets; `beforeToolCall` enforces business rules.
- **Usage limits:** `onRunEnd` records `usage.costUsd` per user; `beforeModelCall` refuses when over the limit.
- **Retrieval:** a `search_docs` tool plus a skill on when to use it.
- **Integrations:** an MCP server per SaaS tool, deferred.
- **Telemetry:** OpenTelemetry spans from `onRunStart`, `afterModelCall`, `afterToolCall` and `onRunEnd`.

## MCP servers as tools

```ts
import { mcpPlugin, connectMcp } from "@alexandernygard/ai-kit-mcp"

const mcp = mcpPlugin([
  { name: "github", transport: { url: "https://api.githubcopilot.com/mcp/", headers: () => ({ Authorization: `Bearer ${token}` }) } },
  { name: "fs", transport: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", root] }, needsApproval: false },
])
createKit({ agents, plugins: [mcp] })
// later: await mcp.close()
```

Each server becomes a toolkit. Tool names are `mcp__<server>__<tool>`, toolkits are deferred by default, and tools need approval unless the server marks them read-only. `include`, `exclude`, `prefix`, `timeoutMs` and `instructions` are per server. Text, images, resources and structured content are passed through. A server that fails to connect is logged and skipped.

For one connection without a plugin, `connectMcp(config)` returns `{ toolkit, client, close }`.

## ai-kit tools as an MCP server

`createMcpServer(tools)` serves ai-kit tools with their JSON Schemas as they are, and `mcpHttpHandler(makeServer, { authorize })` serves that statelessly over streamable HTTP. Point Claude Desktop, Claude Code or any MCP client at it to use your tools there.
