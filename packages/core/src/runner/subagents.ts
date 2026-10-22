import { jsonSchema } from "../schema"
import { type Tool, tool } from "../tools"
import { addUsage } from "../usage"
import type { RunContext } from "./run-context"

/** The `task` tool: runs a subagent in a child session and returns its final answer. */
export function taskTool(rc: RunContext): Tool {
  const agents = rc.resolved.subagents
  const names = agents.map((a) => a.name)
  return tool({
    name: "task",
    description: `Give a self-contained task to a subagent. It works in its own context and returns its final answer. Include everything it needs in the prompt. Agents: ${agents.map((a) => `${a.name} (${a.description ?? "no description"})`).join("; ")}`,
    input: jsonSchema<{ agent: string; prompt: string; description?: string }>({
      type: "object",
      properties: {
        agent: { type: "string", enum: names },
        description: { type: "string", description: "3-5 words for the UI" },
        prompt: { type: "string", description: "The full task" },
      },
      required: ["agent", "prompt"],
    }),
    codeMode: false,
    title: (i) => i.description ?? `Asking ${i.agent}`,
    execute: async ({ agent, prompt }, ctx) => {
      const parent = await rc.host.store.getSession(rc.input.session.id)
      if (!parent) throw new Error("Session disappeared")
      await rc.resolved.hooks.notify("onSubagentStart", { agent, sessionId: "", prompt }, rc.hookCtx)
      const child = await rc.host.runChild({
        parent,
        parentToolCallId: ctx.toolCallId,
        agent,
        prompt,
        options: {
          context: rc.input.options.context,
          clientContext: rc.input.options.clientContext,
          approvalMode: "wait",
          onToolApproval: rc.input.options.onToolApproval,
          permissionMode: rc.input.options.permissionMode,
          signal: rc.signal,
        },
      })
      rc.run.children.add(child)
      rc.emit({ type: "tool-child-session", toolCallId: ctx.toolCallId, sessionId: child.sessionId })
      try {
        for await (const ev of child) rc.emit({ type: "subagent", toolCallId: ctx.toolCallId, sessionId: child.sessionId, event: ev })
        const result = await child.result
        rc.usage = addUsage(rc.usage, result.usage)
        await rc.resolved.hooks.notify("onSubagentEnd", { agent, sessionId: child.sessionId, output: result.output ?? result.text }, rc.hookCtx)
        if (result.finishReason === "error") throw new Error(result.error?.message ?? "Subagent failed")
        if (result.finishReason === "aborted") throw new Error("Subagent was stopped")
        return result.output !== undefined ? result.output : result.text || "(no answer)"
      } finally {
        rc.run.children.delete(child)
      }
    },
  })
}
