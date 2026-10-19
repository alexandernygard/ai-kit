import type { ToolDecision } from "./hooks"
import type { Tool, ToolContext } from "./tools"

/**
 * - `default`: run tools unless a rule or the tool's `needsApproval` says ask.
 * - `ask`: ask for every tool that no `allow` rule covers.
 * - `plan`: allow read-only tools, deny the rest. For planning before acting.
 * - `auto`: allow everything that isn't denied. For trusted, sandboxed work.
 */
export type PermissionMode = "default" | "ask" | "plan" | "auto"

/**
 * `"get_*"` matches tool names with `*` wildcards. `"bash(git *)"` also matches the tool's
 * `permissionKey(input)`. An object rule can test the input directly.
 */
export type PermissionRule = string | { tool: string; when?: (input: any) => boolean }

export interface Permissions<Ctx = any> {
  mode?: PermissionMode
  allow?: PermissionRule[]
  deny?: PermissionRule[]
  ask?: PermissionRule[]
  /** Final say for anything the rules leave open. Like Claude Code's `canUseTool`. */
  canUseTool?: (call: { toolName: string; input: unknown; tool?: Tool }, ctx: ToolContext<Ctx>) => ToolDecision | void | Promise<ToolDecision | void>
}

export function mergePermissions(...ps: Array<Permissions | undefined>): Permissions {
  const out: Permissions = { allow: [], deny: [], ask: [] }
  const checks: NonNullable<Permissions["canUseTool"]>[] = []
  for (const p of ps) {
    if (!p) continue
    if (p.mode) out.mode = p.mode
    out.allow!.push(...(p.allow ?? []))
    out.deny!.push(...(p.deny ?? []))
    out.ask!.push(...(p.ask ?? []))
    if (p.canUseTool) checks.push(p.canUseTool)
  }
  if (checks.length) {
    out.canUseTool = async (call, ctx) => {
      for (const c of checks) {
        const r = await c(call, ctx)
        if (r) return r
      }
    }
  }
  return out
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "s")
}

export function ruleMatches(rule: PermissionRule, toolName: string, input: unknown, tool?: Tool): boolean {
  if (typeof rule !== "string") {
    return globToRegExp(rule.tool).test(toolName) && (rule.when ? safe(() => rule.when!(input)) : true)
  }
  const m = /^([^()]+)\((.*)\)$/s.exec(rule)
  if (!m) return globToRegExp(rule).test(toolName)
  if (!globToRegExp(m[1]!).test(toolName)) return false
  const key = tool?.permissionKey ? safe(() => tool.permissionKey!(input)) : typeof input === "string" ? input : JSON.stringify(input)
  return typeof key === "string" && globToRegExp(m[2]!).test(key)
}

function safe<T>(fn: () => T): T | false {
  try {
    return fn()
  } catch {
    return false
  }
}

/**
 * Decide whether a call may run. Order: deny rules, remembered approvals, allow rules, mode,
 * ask rules, `canUseTool`, the tool's `needsApproval`. Hooks run before this, in the runner.
 */
export async function checkPermission(
  perms: Permissions,
  call: { toolName: string; input: unknown; tool?: Tool },
  ctx: ToolContext,
  remembered: string[] = [],
): Promise<ToolDecision> {
  const { toolName, input, tool } = call
  const any = (rules: PermissionRule[] | undefined) => (rules ?? []).some((r) => ruleMatches(r, toolName, input, tool))

  if (any(perms.deny)) return { decision: "deny", reason: `${toolName} is not allowed here.` }
  if (remembered.includes(toolName)) return { decision: "allow", reason: "approved earlier in this session" }
  if (any(perms.allow)) return { decision: "allow" }

  const mode = perms.mode ?? "default"
  if (mode === "plan" && !tool?.readOnly) {
    return { decision: "deny", reason: `Plan mode: ${toolName} changes things, so it can't run until the plan is approved.` }
  }

  if (perms.canUseTool) {
    const r = await perms.canUseTool(call, ctx)
    if (r) return r
  }
  if (mode === "auto") return { decision: "allow" }
  if (any(perms.ask)) return { decision: "ask" }
  if (mode === "ask" && !tool?.readOnly) return { decision: "ask" }

  const needs = typeof tool?.needsApproval === "function" ? await tool.needsApproval(input, ctx) : tool?.needsApproval
  return needs ? { decision: "ask" } : { decision: "allow" }
}
