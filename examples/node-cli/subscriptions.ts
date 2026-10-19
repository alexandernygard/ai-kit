// Smoke test: one tool-calling turn on your Claude subscription and one on your ChatGPT
// subscription, both through the same ai-kit agent definition.
//   pnpm --filter example-node-cli subscriptions [claude|codex]
import { createKit, defineAgent, jsonSchema, tool, type ToolPart } from "@alexandernygard/ai-kit"
import { claudeAgent } from "@alexandernygard/ai-kit-claude-agent"
import { codex } from "@alexandernygard/ai-kit-codex"

const secret = tool({
  name: "get_secret_number",
  description: "Returns today's secret number.",
  input: jsonSchema({ type: "object", properties: {} }),
  readOnly: true,
  execute: () => ({ secret: 4217 }),
})

const which = process.argv[2]
const drivers = {
  claude: claudeAgent({ model: "claude-haiku-5-5" }),
  codex: codex(),
}

for (const [name, model] of Object.entries(drivers)) {
  if (which && which !== name) continue
  const kit = createKit({
    agents: [defineAgent({ name, model, tools: [secret], instructions: "Answer in one short sentence." })],
  })
  const session = await kit.createSession()
  const run = session.send("Use the get_secret_number tool and tell me the number.")
  process.stdout.write(`\n[${name}] `)
  for await (const e of run) {
    if (e.type === "text-delta") process.stdout.write(e.delta)
    if (e.type === "tool-call") process.stdout.write(`\n  -> ${e.toolName}(${JSON.stringify(e.input)})\n  `)
    if (e.type === "error") process.stdout.write(`\n  error: ${e.error.message}`)
  }
  const r = await run.result
  const tools = r.message.parts.filter((p): p is ToolPart => p.type === "tool").map((t) => `${t.toolName}:${t.state}`)
  console.log(`\n  finish=${r.finishReason} tools=[${tools.join(", ")}] tokens=${r.usage.inputTokens}/${r.usage.outputTokens} cost=${r.usage.costUsd ?? "n/a"}`)
}
