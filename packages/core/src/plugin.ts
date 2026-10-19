import type { Agent, Instructions } from "./agent"
import type { Command } from "./commands"
import type { ContextProvider } from "./context-providers"
import type { Hooks } from "./hooks"
import type { Permissions } from "./permissions"
import type { Skill } from "./skills"
import { collectTools, type Tool, type ToolInput, type Toolkit } from "./tools"

/**
 * A plugin bundles tools, skills, agents, commands, hooks and instructions so an app can add a
 * capability in one line. Add it to the kit (every agent) or to one agent.
 *
 * ```ts
 * const billing = definePlugin({
 *   name: "billing",
 *   tools: [getInvoice, refund],
 *   skills: [refundPolicy],
 *   instructions: "Amounts are in NOK.",
 *   hooks: { beforeToolCall: auditLog },
 * })
 * ```
 */
export interface Plugin<Ctx = any> {
  readonly kind: "plugin"
  name: string
  version?: string
  description?: string
  tools?: ToolInput
  skills?: Skill[]
  agents?: Agent<Ctx>[]
  commands?: Command<Ctx>[]
  hooks?: Hooks<Ctx>
  permissions?: Permissions<Ctx>
  /** Added to every system prompt the plugin applies to. */
  instructions?: Instructions<Ctx>
  /** Context providers for every agent the plugin applies to. */
  contextProviders?: ContextProvider<Ctx>[]
  /** Prefix tool names with `<plugin>__` to avoid clashes. */
  namespaceTools?: boolean
  /** Run once when the kit starts. Use it for async setup like connecting to MCP servers. */
  setup?(api: PluginAPI<Ctx>): void | Promise<void>
}

export interface PluginAPI<Ctx = any> {
  addTools(tools: ToolInput): void
  addSkills(skills: Skill[]): void
  addAgents(agents: Agent<Ctx>[]): void
  addCommands(commands: Command<Ctx>[]): void
  addHooks(hooks: Hooks<Ctx>): void
  addInstructions(instructions: Instructions<Ctx>): void
  addContext(providers: ContextProvider<Ctx>[]): void
}

export function definePlugin<Ctx = any>(plugin: Omit<Plugin<Ctx>, "kind">): Plugin<Ctx> {
  return { ...plugin, kind: "plugin" }
}

/** What a plugin contributes once its `setup` has run. */
export interface ResolvedPlugin<Ctx = any> {
  name: string
  tools: Array<Tool | Toolkit>
  skills: Skill[]
  agents: Agent<Ctx>[]
  commands: Command<Ctx>[]
  hooks: Hooks<Ctx>[]
  permissions?: Permissions<Ctx>
  instructions: Instructions<Ctx>[]
  contextProviders: ContextProvider<Ctx>[]
}

export async function resolvePlugin<Ctx>(plugin: Plugin<Ctx>): Promise<ResolvedPlugin<Ctx>> {
  const out: ResolvedPlugin<Ctx> = {
    name: plugin.name,
    tools: [],
    skills: [...(plugin.skills ?? [])],
    agents: [...(plugin.agents ?? [])],
    commands: [...(plugin.commands ?? [])],
    hooks: plugin.hooks ? [plugin.hooks] : [],
    permissions: plugin.permissions,
    instructions: plugin.instructions ? [plugin.instructions] : [],
    contextProviders: [...(plugin.contextProviders ?? [])],
  }
  const extraTools: ToolInput[] = plugin.tools ? [plugin.tools] : []
  await plugin.setup?.({
    addTools: (t) => extraTools.push(t),
    addSkills: (s) => out.skills.push(...s),
    addAgents: (a) => out.agents.push(...a),
    addCommands: (c) => out.commands.push(...c),
    addHooks: (h) => out.hooks.push(h),
    addInstructions: (i) => out.instructions.push(i),
    addContext: (c) => out.contextProviders.push(...c),
  })
  const { tools, toolkits } = collectTools(extraTools as ToolInput)
  const ns = (t: Tool): Tool => (plugin.namespaceTools ? { ...t, name: `${plugin.name}__${t.name}` } : t)
  out.tools = [...tools.map(ns), ...toolkits.map((k) => ({ ...k, tools: k.tools.map(ns) }))]
  return out
}
