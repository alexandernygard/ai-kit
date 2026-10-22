import type { Instructions } from "../agent"
import { askUserTool, STRUCTURED_OUTPUT_TOOL, structuredOutputTool, todoTool } from "../builtin-tools"
import { type CodeModeOptions, runCodeTool } from "../code-mode"
import { ACTIVE_TOOLS_KEY, type DisclosureOptions, searchToolsTool, toolkitsPrompt, type ToolIndexEntry } from "../disclosure"
import type { Driver, SystemBlock } from "../driver"
import { LOADED_SKILLS_KEY, skillsPrompt, skillTools } from "../skills"
import type { Tool, Toolkit } from "../tools"
import type { RunContext } from "./run-context"
import { taskTool } from "./subagents"
import { callNested } from "./tool-calls"

/** Work out which tools the model sees this step, and which can be called. */
export function assembleTools(rc: RunContext, driver: Driver) {
  const r = rc.resolved
  const active = new Set((rc.state[ACTIVE_TOOLS_KEY] as string[] | undefined) ?? [])
  const loadedSkills = new Set((rc.state[LOADED_SKILLS_KEY] as string[] | undefined) ?? [])
  const all: Tool[] = []
  const deferredEntries: ToolIndexEntry[] = []
  const visible: Tool[] = []

  // With the provider's tool search, every tool is declared from the first step and deferred ones
  // load when the model finds them, so the tool list never changes mid-conversation.
  const nativeSearch = nativeToolSearch(rc, driver)
  const add = (t: Tool, kit?: Toolkit) => {
    all.push(t)
    const deferred = t.defer || kit?.defer
    if (deferred && !active.has(t.name)) deferredEntries.push({ tool: t, toolkit: kit })
    else visible.push(t)
  }
  r.tools.forEach((t) => add(t))
  r.toolkits.forEach((k) => k.tools.forEach((t) => add(t, k)))
  for (const s of r.skills) {
    if (!loadedSkills.has(s.name) && !nativeSearch) continue
    for (const t of s.tools ?? []) {
      const tools = t.kind === "toolkit" ? t.tools : [t]
      for (const x of tools) {
        all.push(x)
        if (nativeSearch) deferredEntries.push({ tool: x })
        else visible.push(x)
      }
    }
  }

  const builtins: Tool[] = []
  if (rc.agent.builtins?.askUser) builtins.push(askUserTool())
  if (rc.agent.builtins?.todos) builtins.push(todoTool())
  if (r.skills.length) {
    builtins.push(
      ...skillTools(r.skills, (s) => {
        loadedSkills.add(s.name)
        rc.stateAccess().set(LOADED_SKILLS_KEY, [...loadedSkills])
      }),
    )
  }
  if (r.subagents.length) builtins.push(taskTool(rc))

  const codeMode = rc.agent.codeMode
  let modelTools: Tool[]
  if (codeMode) {
    const opts: CodeModeOptions = codeMode === true ? {} : codeMode
    const eligible = (t: Tool) => t.codeMode !== false && t.runtime === "server" && !t.provider && (opts.filter?.(t) ?? true)
    const codeVisible = visible.filter(eligible)
    const codeHidden = deferredEntries.map((e) => e.tool).filter(eligible)
    const direct = opts.keepDirectTools ? visible : visible.filter((t) => !eligible(t))
    const runCode = runCodeTool(codeVisible, codeHidden, (name, input, c) => callNested(rc, name, input, c.toolCallId), opts)
    modelTools = [runCode, ...direct, ...builtins]
    const directDeferred = deferredEntries.filter((e) => !eligible(e.tool))
    if (nativeSearch) directDeferred.forEach((e) => modelTools.push(e.tool))
    else if (directDeferred.length && rc.agent.toolSearch !== false) modelTools.push(searchTool(rc, directDeferred, r.toolkits, active))
  } else {
    modelTools = [...visible, ...builtins]
    if (nativeSearch) deferredEntries.forEach((e) => modelTools.push(e.tool))
    else if (deferredEntries.length && rc.agent.toolSearch !== false) modelTools.push(searchTool(rc, deferredEntries, r.toolkits, active))
  }
  rc.deferredNames = nativeSearch ? new Set(deferredEntries.map((e) => e.tool.name)) : new Set()

  // Provider JSON mode only works without tools; otherwise answer through a tool.
  rc.nativeOutputNow = !!rc.outputSchema && driver.capabilities?.structuredOutput === true && modelTools.length === 0
  if (rc.outputSchema && !rc.nativeOutputNow) modelTools.push(structuredOutputTool(rc.outputSchema))

  rc.tools = new Map([...all, ...modelTools].map((t) => [t.name, t]))
  rc.exposed = modelTools
  return { modelTools, hasDeferred: deferredEntries.length > 0, loadedSkills }
}

function searchTool(rc: RunContext, entries: ToolIndexEntry[], toolkits: Toolkit[], active: Set<string>) {
  const opts: DisclosureOptions = typeof rc.agent.toolSearch === "object" ? rc.agent.toolSearch : {}
  return searchToolsTool(
    () => entries,
    toolkits.filter((k) => k.defer),
    (names) => {
      names.forEach((n) => active.add(n))
      rc.stateAccess().set(ACTIVE_TOOLS_KEY, [...active])
    },
    opts,
  )
}

function nativeToolSearch(rc: RunContext, driver: Driver) {
  return driver.capabilities?.toolSearch === true && rc.agent.toolSearch !== false
}

/**
 * The top-level system prompt. It stays the same for the whole session wherever it can: context
 * goes into the conversation as messages instead, so the prompt cache and Claude's thinking stay valid.
 */
export async function systemPrompt(rc: RunContext, hasDeferred: boolean, loadedSkills: Set<string>, driver: Driver): Promise<SystemBlock[]> {
  const ictx = {
    agent: rc.agent.name,
    sessionId: rc.input.session.id,
    context: rc.input.options.context,
    clientContext: rc.input.options.clientContext,
    state: rc.state,
  }
  const resolve = async (i: Instructions) => (typeof i === "function" ? await i(ictx) : i)
  const stable: string[] = []
  for (const i of [rc.agent.instructions, ...rc.resolved.instructions]) {
    if (i) stable.push(await resolve(i))
  }
  const skills = rc.resolved.skills
  if (skills.length) stable.push(skillsPrompt(skills))
  const kits = toolkitsPrompt(rc.resolved.toolkits, hasDeferred)
  if (kits) stable.push(kits)
  if (rc.resolved.subagents.length) {
    stable.push(
      ["# Subagents", "Hand self-contained tasks to a subagent with the `task` tool. Run several at once when they're independent.", ...rc.resolved.subagents.map((a) => `- ${a.name}: ${a.description ?? ""}`)].join("\n"),
    )
  }
  const dynamic: string[] = []
  const active = new Set((rc.state[ACTIVE_TOOLS_KEY] as string[] | undefined) ?? [])
  for (const k of rc.resolved.toolkits) {
    if (k.instructions && (!k.defer || nativeToolSearch(rc, driver) || k.tools.some((t) => active.has(t.name)))) dynamic.push(`# ${k.name}\n${k.instructions}`)
  }
  if (rc.outputSchema && !rc.nativeOutputNow) {
    dynamic.push(`When you're done, call \`${STRUCTURED_OUTPUT_TOOL}\` with your final answer.`)
  }
  void loadedSkills
  const blocks: SystemBlock[] = []
  const s = stable.filter(Boolean).join("\n\n")
  if (s) blocks.push({ text: s, cache: true })
  if (dynamic.length) blocks.push({ text: dynamic.join("\n\n") })
  return blocks
}
