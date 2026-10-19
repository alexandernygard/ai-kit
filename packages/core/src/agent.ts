import type { CodeModeOptions } from "./code-mode"
import type { CompactionOptions } from "./context"
import type { DisclosureOptions } from "./disclosure"
import type { Driver, ModelSettings } from "./driver"
import type { Hooks } from "./hooks"
import type { Permissions } from "./permissions"
import type { Plugin } from "./plugin"
import type { JSONSchema, Schema } from "./schema"
import type { Skill } from "./skills"
import type { ToolInput } from "./tools"
import type { Command } from "./commands"

export interface InstructionContext<Ctx = any> {
  agent: string
  sessionId: string
  context: Ctx
  state: Record<string, unknown>
}

export type Instructions<Ctx = any> = string | ((ctx: InstructionContext<Ctx>) => string | Promise<string>)

export interface Limits {
  /** Model calls per run. Default 25. */
  maxSteps?: number
  /** Stop when the run's cost passes this. */
  maxCostUsd?: number
  /** Stop when input plus output tokens for the run pass this. */
  maxTokens?: number
  /** Wall-clock limit for a run. */
  timeoutMs?: number
  /** Tool calls run at once within a step. Default 8. */
  toolConcurrency?: number
}

export interface AgentConfig<Ctx = any> {
  name: string
  /** What the agent does. Used when it's offered as a subagent. */
  description?: string
  instructions?: Instructions<Ctx>
  model: Driver
  /** Fallback drivers, tried in order when the main one errors before producing output. */
  fallbackModels?: Driver[]
  settings?: ModelSettings
  tools?: ToolInput
  skills?: Skill[]
  /** Agents this one can hand tasks to through the `task` tool. */
  subagents?: Array<Agent<Ctx>>
  commands?: Command<Ctx>[]
  plugins?: Plugin<Ctx>[]
  hooks?: Hooks<Ctx> | Hooks<Ctx>[]
  permissions?: Permissions<Ctx>
  limits?: Limits
  /**
   * Code mode: tools become typed functions inside one `run_code` tool. `true` uses the
   * in-process sandbox, which is fine for local work; pass a real sandbox for production.
   */
  codeMode?: boolean | CodeModeOptions
  /** Tool search for deferred tools. On automatically when any tool is deferred. */
  toolSearch?: boolean | DisclosureOptions
  /** Summarise or trim history as it nears the context window. */
  compaction?: false | CompactionOptions
  /** Structured output for every run of this agent. */
  output?: Schema | JSONSchema
  /** Built-ins to add: `ask_user` and `todo_write`. */
  builtins?: { askUser?: boolean; todos?: boolean }
  /** Shown in UIs. */
  metadata?: Record<string, unknown>
}

export interface Agent<Ctx = any> extends AgentConfig<Ctx> {
  readonly kind: "agent"
}

/**
 * Define an agent.
 *
 * ```ts
 * const support = defineAgent({
 *   name: "support",
 *   instructions: "You help customers with orders.",
 *   model: claudeAgent(),          // your Claude subscription
 *   tools: [lookupOrder, refund],
 *   skills: [refundPolicy],
 * })
 * ```
 */
export function defineAgent<Ctx = any>(config: AgentConfig<Ctx>): Agent<Ctx> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.name)) {
    throw new Error(`Agent name "${config.name}" must be 1-64 letters, digits, _ or -.`)
  }
  return { ...config, kind: "agent" }
}

export function isAgent(x: unknown): x is Agent {
  return typeof x === "object" && x !== null && (x as Agent).kind === "agent"
}
