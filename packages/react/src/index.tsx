import type { AgentInfo, CreateSessionBody, DataPart, FilePart, Message, Part, ReasoningPart, SessionInfo, TextPart } from "@alexandernygard/ai-kit"
import {
  Chat,
  type ChatOptions,
  type ChatState,
  findDocumentSession,
  httpTransport,
  type HttpTransportOptions,
  type ListQuery,
  segments,
  type SettingsStore,
  type ToolNode,
  type Transport,
} from "@alexandernygard/ai-kit-client"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

export * from "@alexandernygard/ai-kit-client"

const TransportContext = createContext<Transport | null>(null)

/**
 * Provide a transport to the hooks below.
 *
 * ```tsx
 * <AIKitProvider baseUrl="/api/ai"><App /></AIKitProvider>
 * ```
 */
export function AIKitProvider(props: { children: ReactNode; transport?: Transport } & HttpTransportOptions) {
  const { children, transport, ...http } = props
  const value = useMemo(() => transport ?? httpTransport(http), [transport, http.baseUrl])
  return <TransportContext.Provider value={value}>{children}</TransportContext.Provider>
}

export function useTransport(): Transport {
  const t = useContext(TransportContext)
  if (!t) throw new Error("Wrap your app in <AIKitProvider> or pass a transport.")
  return t
}

export interface UseChatOptions extends Omit<ChatOptions, "transport" | "sessionId"> {
  /** Open this session; change it to switch. `undefined` starts a new chat. */
  sessionId?: string
  transport?: Transport
}

export type UseChatResult = ChatState & {
  chat: Chat
  send: Chat["send"]
  stop: Chat["stop"]
  approve: Chat["approve"]
  deny: Chat["deny"]
  submitToolOutput: Chat["submitToolOutput"]
  respond: Chat["respond"]
  regenerate: Chat["regenerate"]
  edit: Chat["edit"]
  switchBranch: Chat["switchBranch"]
  versions: Chat["versions"]
  fork: Chat["fork"]
  reset: Chat["reset"]
  /** True while submitted or streaming. */
  isRunning: boolean
}

/**
 * A chat bound to one session.
 *
 * ```tsx
 * const chat = useChat({ sessionId, newSession: { agent: "support" }, onSessionCreated: (s) => navigate(`/c/${s.id}`) })
 * chat.path.map((m) => <MessageView key={m.id} message={m} />)
 * <Composer disabled={chat.isRunning} onSubmit={chat.send} onStop={chat.stop} />
 * ```
 */
export function useChat(options: UseChatOptions = {}): UseChatResult {
  const ctx = useContext(TransportContext)
  const transport = options.transport ?? ctx
  if (!transport) throw new Error("useChat needs a transport: use <AIKitProvider> or pass one.")
  // Latest callbacks without recreating the chat.
  const latest = useRef(options)
  latest.current = options

  const [chat] = useState(
    () =>
      new Chat({
        ...options,
        transport,
        sessionId: options.sessionId,
        onEvent: (e) => latest.current.onEvent?.(e),
        onFinish: (m) => latest.current.onFinish?.(m),
        onError: (e) => latest.current.onError?.(e),
        onSessionCreated: (s) => latest.current.onSessionCreated?.(s),
        getContext: () => latest.current.getContext?.(),
      }),
  )
  useEffect(() => chat.setClientTools(options.clientTools), [chat, options.clientTools])

  const loaded = useRef(options.sessionId)
  useEffect(() => {
    if (options.sessionId === loaded.current) return
    loaded.current = options.sessionId
    if (options.sessionId && options.sessionId !== chat.getSnapshot().sessionId) void chat.load(options.sessionId)
    else if (!options.sessionId) chat.reset(options.newSession)
  }, [options.sessionId, chat])

  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot, chat.getSnapshot)
  const actions = useMemo(
    () => ({
      chat,
      send: chat.send.bind(chat),
      stop: chat.stop.bind(chat),
      approve: chat.approve.bind(chat),
      deny: chat.deny.bind(chat),
      submitToolOutput: chat.submitToolOutput.bind(chat),
      respond: chat.respond.bind(chat),
      regenerate: chat.regenerate.bind(chat),
      edit: chat.edit.bind(chat),
      switchBranch: chat.switchBranch.bind(chat),
      versions: chat.versions.bind(chat),
      fork: chat.fork.bind(chat),
      reset: chat.reset.bind(chat),
    }),
    [chat],
  )
  return { ...state, ...actions, isRunning: state.status === "submitted" || state.status === "streaming" }
}

export interface UseAssistantOptions extends Omit<UseChatOptions, "sessionId" | "newSession"> {
  /** The open document. Each document keeps its own conversation. */
  documentId: string
  agent?: string
  /** Stored on new sessions next to `documentId`. */
  metadata?: Record<string, unknown>
}

export type UseAssistantResult = UseChatResult & { documentId: string }

/**
 * The assistant panel for a document editor: one conversation per document, reopened when the
 * user comes back to it. Switching `documentId` switches the conversation.
 *
 * ```tsx
 * const { kit, transport } = createBrowserKit({ agents: [assistant] })
 * const chat = useAssistant({ transport, documentId: file.id, getContext: () => ({ selection }) })
 * ```
 */
export function useAssistant(options: UseAssistantOptions): UseAssistantResult {
  const { documentId, agent, metadata, ...chatOptions } = options
  const ctx = useContext(TransportContext)
  const transport = options.transport ?? ctx
  if (!transport) throw new Error("useAssistant needs a transport: use <AIKitProvider> or pass one.")
  const chat = useChat({ ...chatOptions, transport })
  const [resolving, setResolving] = useState(true)
  const metaKey = JSON.stringify(metadata ?? {})

  useEffect(() => {
    let live = true
    const newSession = { agent, metadata: { ...metadata, documentId } }
    chat.reset(newSession)
    setResolving(true)
    findDocumentSession(transport, documentId, agent)
      .catch(() => undefined)
      .then(async (found) => {
        if (!live) return
        setResolving(false)
        if (found) await chat.chat.load(found.id)
      })
    return () => {
      live = false
    }
  }, [transport, documentId, agent, metaKey])

  return { ...chat, status: resolving ? "loading" : chat.status, documentId }
}

/** Read and update a `settingsStore` (API key, model, effort). */
export function useSettings<S>(store: SettingsStore<S>): [S, (patch: Partial<S>) => void] {
  const settings = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return [settings, store.set]
}

export interface UseSessionsResult {
  sessions: SessionInfo[]
  loading: boolean
  error: string | null
  hasMore: boolean
  refresh(): Promise<void>
  loadMore(): Promise<void>
  create(body?: CreateSessionBody): Promise<SessionInfo>
  rename(id: string, title: string): Promise<void>
  remove(id: string): Promise<void>
}

/** The current user's sessions, newest first. For a sidebar or history list. */
export function useSessions(query: ListQuery & { transport?: Transport } = {}): UseSessionsResult {
  const ctx = useContext(TransportContext)
  const transport = query.transport ?? ctx
  if (!transport) throw new Error("useSessions needs a transport.")
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const key = `${query.agent}|${query.parent}|${query.limit}`

  const fetchPage = useCallback(
    async (after?: string) => {
      setLoading(true)
      try {
        const page = await transport.listSessions({ agent: query.agent, parent: query.parent, limit: query.limit, cursor: after })
        setSessions((cur) => (after ? [...cur, ...page.sessions] : page.sessions))
        setCursor(page.nextCursor)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [transport, key],
  )

  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

  return {
    sessions,
    loading,
    error,
    hasMore: cursor !== undefined,
    refresh: () => fetchPage(),
    loadMore: async () => {
      if (cursor) await fetchPage(cursor)
    },
    async create(body) {
      const s = await transport.createSession(body)
      setSessions((cur) => [s, ...cur])
      return s
    },
    async rename(id, title) {
      const s = await transport.updateSession(id, { title })
      setSessions((cur) => cur.map((x) => (x.id === id ? s : x)))
    },
    async remove(id) {
      await transport.deleteSession(id)
      setSessions((cur) => cur.filter((x) => x.id !== id))
    },
  }
}

/** Agents the server offers, with their slash commands. */
export function useAgents(transport?: Transport): { agents: AgentInfo[]; loading: boolean; error: string | null } {
  const ctx = useContext(TransportContext)
  const t = transport ?? ctx
  const [state, setState] = useState<{ agents: AgentInfo[]; loading: boolean; error: string | null }>({ agents: [], loading: true, error: null })
  useEffect(() => {
    if (!t) return
    let live = true
    t.agents().then(
      (agents) => live && setState({ agents, loading: false, error: null }),
      (e) => live && setState({ agents: [], loading: false, error: String(e?.message ?? e) }),
    )
    return () => {
      live = false
    }
  }, [t])
  return state
}

export interface PartRenderers {
  text?: (part: TextPart, message: Message) => ReactNode
  reasoning?: (part: ReasoningPart, message: Message) => ReactNode
  /** A run of consecutive tool calls; nested code-mode calls are in `children`. */
  tools?: (tools: ToolNode[], message: Message) => ReactNode
  /** Per tool name, for custom tool UIs (a weather card, a booking form). Falls back to `tools`. */
  tool?: Record<string, (tool: ToolNode, message: Message) => ReactNode>
  file?: (part: FilePart, message: Message) => ReactNode
  /** Per data part name (`todos`, or your own). */
  data?: Record<string, (part: DataPart, message: Message) => ReactNode>
}

/**
 * Render a message's parts with your own components. Headless: you supply every visual,
 * for example `Bubble`, `Trace` and `Questionnaire` from @alexandernygard/components.
 *
 * ```tsx
 * <MessageParts message={m} render={{
 *   text: (p) => <Markdown>{p.text}</Markdown>,
 *   tools: (tools) => <ToolTrace tools={tools} />,
 *   tool: { ask_user: (t) => <AskUser call={t} onAnswer={(a) => chat.submitToolOutput(t.toolCallId, a)} /> },
 * }} />
 * ```
 */
export function MessageParts({ message, render }: { message: Message; render: PartRenderers }) {
  const segs = useMemo(() => segments(message), [message])
  return (
    <>
      {segs.map((s) => {
        switch (s.kind) {
          case "text":
            return <Fragment key={s.key}>{render.text?.(s.part, message) ?? s.part.text}</Fragment>
          case "reasoning":
            return <Fragment key={s.key}>{render.reasoning?.(s.part, message) ?? null}</Fragment>
          case "file":
            return <Fragment key={s.key}>{render.file?.(s.part, message) ?? null}</Fragment>
          case "data":
            return <Fragment key={s.key}>{render.data?.[s.part.name]?.(s.part, message) ?? null}</Fragment>
          case "tools": {
            const custom = s.tools.filter((t) => render.tool?.[t.toolName])
            const rest = s.tools.filter((t) => !render.tool?.[t.toolName])
            return (
              <Fragment key={s.key}>
                {rest.length ? (render.tools?.(rest, message) ?? null) : null}
                {custom.map((t) => (
                  <Fragment key={t.toolCallId}>{render.tool![t.toolName]!(t, message)}</Fragment>
                ))}
              </Fragment>
            )
          }
        }
      })}
    </>
  )
}

function Fragment({ children }: { children?: ReactNode }) {
  return <>{children}</>
}

/** Parts for a message with text and attached files, ready for `send`. */
export function composeParts(text: string, files: Array<{ mediaType: string; url?: string; data?: string; filename?: string }> = []): Part[] {
  const parts: Part[] = files.map((f, i) => ({ type: "file", id: `file_${i}_${Date.now()}`, ...f }))
  if (text.trim()) parts.push({ type: "text", id: `txt_${Date.now()}`, text, state: "done" })
  return parts
}
