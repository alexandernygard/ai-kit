import type { Agent, Instructions } from "./agent"
import type { Command } from "./commands"
import type { ModelDriver } from "./driver"
import type { EventEnvelope } from "./events"
import { HookRunner, type Hooks } from "./hooks"
import { createId, now } from "./id"
import { type Message, textOf, type UserContent } from "./messages"
import { mergePermissions, type Permissions } from "./permissions"
import { type Plugin, type ResolvedPlugin, resolvePlugin } from "./plugin"
import { Run, type RunResult } from "./run"
import type { ResolvedAgent, RunnerHost } from "./runner"
import { type SendOptions, Session } from "./session"
import type { Skill } from "./skills"
import { memoryStore } from "./store/kv"
import type { ListSessionsQuery, SessionRecord, Store } from "./store/types"
import { collectTools, type Tool, type ToolInput, type Toolkit } from "./tools"
import { defaultPricing, type ModelPrice } from "./usage"

export interface KitOptions<Ctx = any> {
  agents: Agent<Ctx>[]
  /** Where sessions live. Default: in memory. */
  store?: Store
  /** Plugins for every agent. */
  plugins?: Plugin<Ctx>[]
  /** Tools every agent gets. */
  tools?: ToolInput
  skills?: Skill[]
  commands?: Command<Ctx>[]
  hooks?: Hooks<Ctx> | Hooks<Ctx>[]
  permissions?: Permissions<Ctx>
  /** Added to every agent's system prompt. */
  instructions?: Instructions<Ctx>
  /** Agent for sessions created without one. Default: the first. */
  defaultAgent?: string
  /** USD per million tokens by model id prefix, merged over the built-in table. */
  pricing?: Record<string, ModelPrice>
  /**
   * Session titles. `first-message` (default) uses the start of the first message; a model
   * driver writes a short title; `false` leaves titles alone.
   */
  title?: false | "first-message" | ModelDriver
  /** Store run events so clients can reconnect mid-run. Default true when the store supports it. */
  persistEvents?: boolean
}

export interface CreateSessionOptions {
  agent?: string
  id?: string
  title?: string
  ownerId?: string
  metadata?: Record<string, unknown>
  state?: Record<string, unknown>
  parentSessionId?: string
  parentToolCallId?: string
  forkedFrom?: SessionRecord["forkedFrom"]
}

export interface AgentInfo {
  name: string
  description?: string
  model: string
  kind: "model" | "harness"
  metadata?: Record<string, unknown>
  commands: Array<{ name: string; description: string; argumentHint?: string }>
}

/**
 * The runtime: agents, sessions, runs and storage. Make one per app, on the server or in the
 * browser.
 *
 * ```ts
 * const kit = createKit({ agents: [support], store: fileStore(".ai-kit") })
 * const session = await kit.createSession({ agent: "support", ownerId: user.id })
 * const run = session.send("Where's my order?", { context: { user } })
 * ```
 */
export class Kit<Ctx = any> {
  readonly store: Store
  /** @internal */
  readonly host: RunnerHost
  private readonly agentsByName = new Map<string, Agent<Ctx>>()
  private readonly resolved = new Map<string, Promise<ResolvedAgent<Ctx>>>()
  private readonly runs = new Map<string, Run>()
  private plugins: ResolvedPlugin<Ctx>[] = []
  private readyPromise?: Promise<void>
  private readonly pricing: Record<string, ModelPrice>

  constructor(private readonly options: KitOptions<Ctx>) {
    if (!options.agents.length) throw new Error("createKit needs at least one agent.")
    this.store = options.store ?? memoryStore()
    this.pricing = { ...defaultPricing, ...options.pricing }
    for (const a of options.agents) this.registerAgent(a)
    const self = this
    this.host = {
      store: this.store,
      pricing: this.pricing,
      persistEvents: options.persistEvents ?? !!this.store.appendEvents,
      resolve: (name) => this.resolve(name),
      registerRun: (r) => this.runs.set(r.id, r),
      unregisterRun: (r) => this.unregisterRun(r),
      createRun: (sid, agent) => this.createRun(sid, agent),
      async runChild({ parent, parentToolCallId, agent, prompt, options: o }) {
        const child = await self.createSession({
          agent,
          ownerId: parent.ownerId,
          parentSessionId: parent.id,
          parentToolCallId,
          title: prompt.slice(0, 80),
        })
        return child.send(prompt, o as SendOptions<Ctx>)
      },
      autoTitle: (s, m, run) => this.autoTitle(s, m, run),
    }
  }

  private registerAgent(a: Agent<Ctx>) {
    const existing = this.agentsByName.get(a.name)
    if (existing && existing !== a) throw new Error(`Two different agents are named "${a.name}".`)
    if (existing) return
    this.agentsByName.set(a.name, a)
    for (const s of a.subagents ?? []) this.registerAgent(s)
  }

  /** Run plugin setup. Called for you on first use; await it to surface setup errors early. */
  ready(): Promise<void> {
    this.readyPromise ??= (async () => {
      this.plugins = await Promise.all((this.options.plugins ?? []).map((p) => resolvePlugin(p)))
      for (const p of this.plugins) for (const a of p.agents) this.registerAgent(a)
    })()
    return this.readyPromise
  }

  /** @internal Merge kit, plugin and agent contributions. Cached per agent. */
  resolve(name: string): Promise<ResolvedAgent<Ctx>> {
    let p = this.resolved.get(name)
    if (!p) {
      p = (async () => {
        await this.ready()
        const agent = this.agentsByName.get(name)
        if (!agent) throw new Error(`No agent named "${name}". Agents: ${[...this.agentsByName.keys()].join(", ")}`)
        const agentPlugins = await Promise.all((agent.plugins ?? []).map((pl) => resolvePlugin(pl)))
        const plugins = [...this.plugins, ...agentPlugins]
        const toolInputs: ToolInput[] = [this.options.tools ?? [], ...plugins.map((pl) => pl.tools), agent.tools ?? []]
        const { tools, toolkits } = collectTools(toolInputs as ToolInput)
        const hooks: Hooks<Ctx>[] = [
          ...toArray(this.options.hooks),
          ...plugins.flatMap((pl) => pl.hooks),
          ...toArray(agent.hooks),
        ]
        const resolved: ResolvedAgent<Ctx> = {
          agent,
          tools: dedupe(tools),
          toolkits: dedupeKits(toolkits),
          skills: dedupeBy([...(this.options.skills ?? []), ...plugins.flatMap((pl) => pl.skills), ...(agent.skills ?? [])], (s) => s.name),
          hooks: new HookRunner(hooks),
          permissions: mergePermissions(this.options.permissions, ...plugins.map((pl) => pl.permissions), agent.permissions),
          instructions: [...(this.options.instructions ? [this.options.instructions] : []), ...plugins.flatMap((pl) => pl.instructions)],
          commands: dedupeBy([...(this.options.commands ?? []), ...plugins.flatMap((pl) => pl.commands), ...(agent.commands ?? [])], (c) => c.name),
          subagents: agent.subagents ?? [],
        }
        return resolved
      })()
      p.catch(() => this.resolved.delete(name))
      this.resolved.set(name, p)
    }
    return p
  }

  /** Agents for pickers and the server's `/agents` route. Subagents included. */
  async agents(): Promise<AgentInfo[]> {
    await this.ready()
    return Promise.all(
      [...this.agentsByName.values()].map(async (a) => {
        const r = await this.resolve(a.name)
        return {
          name: a.name,
          description: a.description,
          model: a.model.modelId ? `${a.model.provider}:${a.model.modelId}` : a.model.provider,
          kind: a.model.kind,
          metadata: a.metadata,
          commands: r.commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
        }
      }),
    )
  }

  getAgent(name: string): Agent<Ctx> | undefined {
    return this.agentsByName.get(name)
  }

  async createSession(options: CreateSessionOptions = {}): Promise<Session<Ctx>> {
    await this.ready()
    const agent = options.agent ?? this.options.defaultAgent ?? this.options.agents[0]!.name
    if (!this.agentsByName.has(agent)) throw new Error(`No agent named "${agent}"`)
    const t = now()
    const rec: SessionRecord = {
      id: options.id ?? createId("ses"),
      agent,
      title: options.title,
      ownerId: options.ownerId,
      headId: null,
      parentSessionId: options.parentSessionId,
      parentToolCallId: options.parentToolCallId,
      forkedFrom: options.forkedFrom,
      state: options.state ?? {},
      metadata: options.metadata,
      activeRunId: null,
      createdAt: t,
      updatedAt: t,
    }
    await this.store.createSession(rec)
    return new Session(this, rec)
  }

  async getSession(id: string): Promise<Session<Ctx> | null> {
    const rec = await this.store.getSession(id)
    return rec ? new Session(this, rec) : null
  }

  async listSessions(query: ListSessionsQuery = {}) {
    const page = await this.store.listSessions(query)
    return { sessions: page.sessions.map((s) => new Session(this, s)), nextCursor: page.nextCursor }
  }

  /** Start a new session and send the first message. */
  async run(content: UserContent, options: SendOptions<Ctx> & CreateSessionOptions = {}): Promise<Run> {
    const session = await this.createSession(options)
    return session.send(content, options)
  }

  /**
   * One-off generation: runs in a temporary session that's deleted afterwards, and returns
   * the result. Pass `output` for structured data.
   *
   * ```ts
   * const { output } = await kit.generate("Extract the invoice fields", { agent: "extractor", output: invoiceSchema })
   * ```
   */
  async generate(content: UserContent, options: SendOptions<Ctx> & { agent?: string; ownerId?: string } = {}): Promise<RunResult> {
    const session = await this.createSession({ agent: options.agent, ownerId: options.ownerId, title: "(generate)", metadata: { ephemeral: true } })
    try {
      return await session.send(content, options).result
    } finally {
      await session.delete().catch(() => {})
    }
  }

  /** A live run in this process. */
  getRun(runId: string): Run | undefined {
    return this.runs.get(runId)
  }

  /** Events of a run, live when it's running here, from the store's log otherwise. */
  async *runEvents(runId: string, after = -1, signal?: AbortSignal): AsyncGenerator<EventEnvelope> {
    const live = this.runs.get(runId)
    if (live) {
      yield* live.events(after, signal)
      return
    }
    for (const e of (await this.store.readEvents?.(runId, after)) ?? []) yield e
  }

  /** Slash commands an agent accepts. */
  async commands(agent: string): Promise<Command<Ctx>[]> {
    return (await this.resolve(agent)).commands
  }

  /** @internal */
  createRun(sessionId: string, agent: string): Run {
    const run = new Run(createId("run"), sessionId, agent)
    this.runs.set(run.id, run)
    return run
  }

  /** @internal */
  unregisterRun(run: Run) {
    // Keep finished runs briefly so clients can still reconnect from memory.
    const t = setTimeout(() => {
      if (this.runs.get(run.id) === run) this.runs.delete(run.id)
    }, 60_000) as unknown as { unref?: () => void }
    t.unref?.()
  }

  private async autoTitle(session: SessionRecord, first: Message, run: Run) {
    const mode = this.options.title ?? "first-message"
    if (mode === false || session.parentSessionId) return
    const text = textOf(first).trim().replace(/\s+/g, " ")
    if (!text) return
    let title = text.length > 60 ? `${text.slice(0, 57).trimEnd()}...` : text
    if (typeof mode === "object") {
      let out = ""
      for await (const e of mode.stream({
        system: [{ text: "Write a title of 2 to 6 words for a conversation that starts with the user's message. Reply with the title only, no quotes." }],
        messages: [{ role: "user", content: [{ type: "text", text: text.slice(0, 2000) }] }],
        tools: [],
        settings: { maxOutputTokens: 30 },
        signal: AbortSignal.timeout(15_000),
      })) {
        if (e.type === "text-delta") out += e.delta
      }
      title = out.trim().replace(/^["']|["']$/g, "") || title
    }
    await this.store.updateSession(session.id, { title })
    if (!run.hub.done) run.hub.push({ type: "session-update", patch: { title } })
  }
}

export function createKit<Ctx = any>(options: KitOptions<Ctx>): Kit<Ctx> {
  return new Kit(options)
}

function toArray<T>(x: T | T[] | undefined): T[] {
  return x === undefined ? [] : Array.isArray(x) ? x : [x]
}

function dedupeBy<T>(items: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>()
  for (const i of items) m.set(key(i), i)
  return [...m.values()]
}

const dedupe = (tools: Tool[]) => dedupeBy(tools, (t) => t.name)
const dedupeKits = (kits: Toolkit[]) => dedupeBy(kits, (k) => k.name)
