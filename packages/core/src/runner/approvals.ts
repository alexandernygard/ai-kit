import type { ToolCallInfo, ToolDecision } from "../hooks"
import { checkPermission, type Permissions, ruleMatches } from "../permissions"
import type { ToolResponse } from "../run"
import type { Tool } from "../tools"
import type { RunContext } from "./run-context"
import { toolContext } from "./tool-calls"

/** Session state key for tools the user chose to "always allow". */
export const REMEMBERED_TOOLS_KEY = "ai-kit.allowedTools"

function approvalMode(rc: RunContext): "wait" | "suspend" {
  return rc.input.options.approvalMode ?? "suspend"
}

export function applyApproval(rc: RunContext, call: ToolCallInfo, t: Tool, response: ToolResponse) {
  const approved = "approved" in response ? response.approved : true
  const message = "approved" in response ? response.message : undefined
  rc.emit({ type: "tool-approval-response", toolCallId: call.toolCallId, approved, message })
  if (!approved) {
    rc.emit({
      type: "tool-result",
      toolCallId: call.toolCallId,
      output: `The user denied this.${message ? ` They said: ${message}` : ""}`,
      isError: true,
    })
    return null
  }
  if ("remember" in response && response.remember) {
    const list = new Set((rc.state[REMEMBERED_TOOLS_KEY] as string[] | undefined) ?? [])
    list.add(call.toolName)
    rc.stateAccess().set(REMEMBERED_TOOLS_KEY, [...list])
  }
  const input = "approved" in response && response.input !== undefined ? response.input : call.input
  return { call: { ...call, input }, tool: t }
}

export async function decide(rc: RunContext, call: ToolCallInfo, t: Tool | undefined): Promise<ToolDecision> {
  const fromHook = await rc.resolved.hooks.beforeToolCall(call, rc.hookCtx)
  if (fromHook?.decision === "deny" || fromHook?.decision === "ask") return fromHook
  const input = fromHook?.input ?? call.input
  const perms: Permissions = { ...rc.resolved.permissions, mode: rc.input.options.permissionMode ?? rc.resolved.permissions.mode }
  // A hook's explicit allow skips the prompt, like Claude Code's PreToolUse. Deny rules still win.
  if (fromHook?.decision === "allow") {
    if ((perms.deny ?? []).some((r) => ruleMatches(r, call.toolName, input, t))) return { decision: "deny", reason: `${call.toolName} is not allowed here.` }
    return { decision: "allow", input }
  }
  const remembered = (rc.state[REMEMBERED_TOOLS_KEY] as string[] | undefined) ?? []
  const d = await checkPermission(perms, { toolName: call.toolName, input, tool: t }, toolContext(rc, call.toolCallId, call.toolName), remembered)
  if (d.decision === "allow") return { ...d, input }
  return d
}

/** Ask for approval. Resolves with the answer, or "pending" when the run suspends. */
export async function askApproval(rc: RunContext, call: ToolCallInfo, reason: string | undefined, forceWait = false): Promise<ToolResponse | "pending"> {
  const handler = rc.input.options.onToolApproval
  const mode = forceWait || handler ? "wait" : approvalMode(rc)
  rc.emit({ type: "tool-approval-request", toolCallId: call.toolCallId, reason, mode })
  if (handler) return handler({ ...call, reason })
  if (mode === "suspend") {
    rc.suspended = true
    return "pending"
  }
  return waitFor(rc, call.toolCallId)
}

export async function awaitClient(
  rc: RunContext,
  call: ToolCallInfo,
  response: ToolResponse | undefined,
  wasWaiting: boolean,
): Promise<{ output: unknown; isError?: boolean } | "pending"> {
  if (response && "output" in response) return response
  if (response && "approved" in response && !response.approved) {
    return { output: `The user dismissed this.${response.message ? ` They said: ${response.message}` : ""}`, isError: true }
  }
  const handler = rc.input.options.onClientTool
  if (handler) {
    rc.emit({ type: "tool-awaiting-output", toolCallId: call.toolCallId, mode: "wait" })
    try {
      return { output: await handler(call) }
    } catch (e) {
      return { output: e instanceof Error ? e.message : String(e), isError: true }
    }
  }
  const mode = approvalMode(rc)
  if (!wasWaiting || mode === "wait") rc.emit({ type: "tool-awaiting-output", toolCallId: call.toolCallId, mode })
  if (mode === "suspend") {
    rc.suspended = true
    return "pending"
  }
  const r = await waitFor(rc, call.toolCallId)
  if ("output" in r) return r
  return { output: r.approved ? (r.message ?? "") : `The user dismissed this.${r.message ? ` They said: ${r.message}` : ""}`, isError: !r.approved }
}

function waitFor(rc: RunContext, toolCallId: string): Promise<ToolResponse> {
  return new Promise((resolve, reject) => {
    if (rc.signal.aborted) return reject(new Error("Aborted"))
    rc.run.waiting.set(toolCallId, resolve)
    rc.signal.addEventListener(
      "abort",
      () => {
        rc.run.waiting.delete(toolCallId)
        reject(new Error("Aborted"))
      },
      { once: true },
    )
  })
}
