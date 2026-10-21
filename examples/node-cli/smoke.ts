// Smoke test: one tool-calling turn against the Claude API.
//   pnpm --filter example-node-cli smoke [model]
// Credentials come from ANTHROPIC_API_KEY or an `ant auth login` profile.
import { createKit, defineAgent, jsonSchema, tool, type ToolPart } from "@alexandernygard/ai-kit"
import { claude } from "@alexandernygard/ai-kit-anthropic"

const secret = tool({
  name: "get_secret_number",
  description: "Returns today's secret number.",
  input: jsonSchema({ type: "object", properties: {} }),
  readOnly: true,
  execute: () => ({ secret: 4217 }),
})

const model = process.argv[2] ?? "claude-haiku-5-5"
const kit = createKit({
  agents: [defineAgent({ name: "smoke", model: claude(model, { maxTokens: 2000 }), tools: [secret], instructions: "Answer in one short sentence." })],
})
const session = await kit.createSession()
const run = session.send("Use the get_secret_number tool and tell me the number.")
process.stdout.write(`[${model}] `)
for await (const e of run) {
  if (e.type === "text-delta") process.stdout.write(e.delta)
  if (e.type === "tool-call") process.stdout.write(`\n  -> ${e.toolName}(${JSON.stringify(e.input)})\n  `)
  if (e.type === "error") process.stdout.write(`\n  error: ${e.error.message}`)
}
const r = await run.result
const tools = r.message.parts.filter((p): p is ToolPart => p.type === "tool").map((t) => `${t.toolName}:${t.state}`)
console.log(`\n  finish=${r.finishReason} tools=[${tools.join(", ")}] tokens=${r.usage.inputTokens}/${r.usage.outputTokens} cost=${r.usage.costUsd ?? "n/a"}`)
