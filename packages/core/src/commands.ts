import type { Message, Part } from "./messages"
import { textPart } from "./messages"

/**
 * Slash commands: `/review src/app.ts` expands into a full prompt before it reaches the agent.
 * List them in the UI with `kit.commands(agent)`.
 */
export interface Command<Ctx = any> {
  name: string
  description: string
  /** Shown in autocomplete, e.g. `<file>`. */
  argumentHint?: string
  prompt: (args: string, ctx: { context: Ctx; sessionId: string }) => string | Part[] | Promise<string | Part[]>
}

export function defineCommand<Ctx = any>(command: Command<Ctx>): Command<Ctx> {
  if (!/^[a-z0-9][a-z0-9:_-]*$/i.test(command.name)) throw new Error(`Command name "${command.name}" is invalid.`)
  return command
}

/** Expand `/name args` in the message's first text part. Unknown commands pass through. */
export async function expandCommand<Ctx>(
  message: Message,
  commands: Command<Ctx>[],
  ctx: { context: Ctx; sessionId: string },
): Promise<{ message: Message; command?: string }> {
  const first = message.parts.find((p) => p.type === "text")
  if (!first || first.type !== "text") return { message }
  const m = /^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i.exec(first.text.trim())
  if (!m) return { message }
  const cmd = commands.find((c) => c.name.toLowerCase() === m[1]!.toLowerCase())
  if (!cmd) return { message }
  const expanded = await cmd.prompt((m[2] ?? "").trim(), ctx)
  const parts = typeof expanded === "string" ? [textPart(expanded)] : expanded
  const rest = message.parts.filter((p) => p !== first)
  return {
    message: { ...message, parts: [...parts, ...rest], metadata: { ...message.metadata, command: { name: cmd.name, text: first.text } } },
    command: cmd.name,
  }
}
