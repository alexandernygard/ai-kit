import type { Agent, Limits } from "./agent"
import type { ToolChoice } from "./driver"
import type { HookRunner } from "./hooks"
import type { Message } from "./messages"
import type { PermissionMode, Permissions } from "./permissions"
import type { Run, ToolResponse } from "./run"
import type { JSONSchema, Schema } from "./schema"
import type { Skill } from "./skills"
import type { SessionRecord, Store } from "./store/types"
import type { Tool, Toolkit } from "./tools"
import type { ModelPrice } from "./usage"
import type { Instructions } from "./agent"
import type { Command } from "./commands"
import type { ContextProvider } from "./context-providers"
import type { ModelSettings } from "./driver"
import { RunContext } from "./runner/run-context"

/*
 * The agent loop. `startRun` creates a RunContext (runner/run-context.ts), which owns a run's
 * state and lifecycle. The rest of runner/ works on it:
 * - step-loop.ts: one model call after another until the agent stops
 * - tool-assembly.ts: which tools the model sees, and the system prompt
 * - tool-calls.ts: validating and running tool calls
 * - approvals.ts: permissions, approvals and client tools
 * - context-window.ts: context providers, context usage and compaction
 * - subagents.ts: the `task` tool
 */

export { REMEMBERED_TOOLS_KEY } from "./runner/approvals"

/** An agent with its plugins and kit-wide additions merged in. */
export interface ResolvedAgent<Ctx = any> {
  agent: Agent<Ctx>
  tools: Tool[]
  toolkits: Toolkit[]
  skills: Skill[]
  hooks: HookRunner<Ctx>
  permissions: Permissions<Ctx>
  instructions: Instructions<Ctx>[]
  contextProviders: ContextProvider<Ctx>[]
  commands: Command<Ctx>[]
  subagents: Agent<Ctx>[]
}

export interface RunOptions<Ctx = any> {
  context?: Ctx
  /**
   * What the browser sent with the message: the current page, a selection, the open document.
   * Untrusted. Context providers, tools and hooks can read it; add `clientContext()` to show it
   * to the model.
   */
  clientContext?: Record<string, unknown>
  /** Structured output for this run. */
  output?: Schema | JSONSchema
  settings?: ModelSettings
  permissionMode?: PermissionMode
  /**
   * What happens when a call needs an approval or a client tool's output.
   * - `suspend` (default for model drivers): the run ends with `awaiting-input`; call
   *   `session.resume()` with the answers. Survives restarts and suits serverless.
   * - `wait`: the run pauses in memory until `run.respond()`.
   */
  approvalMode?: "wait" | "suspend"
  /** Decide approvals in code instead of pausing. */
  onToolApproval?: (request: { toolCallId: string; toolName: string; input: unknown; reason?: string }) => ToolResponse | Promise<ToolResponse>
  /** Run client tools in-process (for apps that run the kit in the browser). */
  onClientTool?: (call: { toolCallId: string; toolName: string; input: unknown }) => unknown | Promise<unknown>
  limits?: Limits
  signal?: AbortSignal
  /** Extra tool choice for the first step. */
  toolChoice?: ToolChoice
}

/** What the runner needs from the kit. */
export interface RunnerHost {
  store: Store
  pricing: Record<string, ModelPrice>
  contextWindows: Record<string, number>
  resolve(agentName: string): Promise<ResolvedAgent>
  registerRun(run: Run): void
  unregisterRun(run: Run): void
  createRun(sessionId: string, agent: string): Run
  persistEvents: boolean
  /** How long a run's lease on its session lasts; the runner renews it while alive. */
  runLeaseMs: number
  /** Create a child session and run an agent in it. Used for subagents. */
  runChild(params: {
    parent: SessionRecord
    parentToolCallId: string
    agent: string
    prompt: string
    options: RunOptions
  }): Promise<Run>
  autoTitle(session: SessionRecord, userMessage: Message, run: Run): Promise<void>
}

export interface RunInput {
  session: SessionRecord
  /** Messages before the assistant message, on the active path. */
  history: Message[]
  /** The new user message; absent when resuming. */
  userMessage?: Message
  /** Assistant message to continue (resume); a new one is created otherwise. */
  continueMessage?: Message
  responses?: Record<string, ToolResponse>
  options: RunOptions
}

/** Start a run in the background and return its handle right away. */
export function startRun(host: RunnerHost, resolved: ResolvedAgent, input: RunInput, run: Run): Run {
  const rc = new RunContext(host, resolved, input, run)
  host.registerRun(run)
  void rc.execute().finally(() => host.unregisterRun(run))
  return run
}
