// The API server: the ai-kit HTTP handler on node:http. Vite proxies /api here.
import { createServer } from "node:http"
import { createKit } from "@alexandernygard/ai-kit"
import { fileStore, toNodeHandler } from "@alexandernygard/ai-kit-node"
import { createHandler } from "@alexandernygard/ai-kit-server"
import { createAgent } from "./agent.ts"

const kit = createKit({ agents: [await createAgent()], store: fileStore(".ai-kit") })

const handler = createHandler(kit, {
  // A real app reads its session cookie here. Every request is one demo user.
  auth: () => ({ userId: "demo", context: { name: "Alex" } }),
})

createServer(toNodeHandler(handler)).listen(8787, () => console.log("ai-kit API on http://localhost:8787/api/ai"))
