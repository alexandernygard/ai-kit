import type { AskUserQuestion, ContextUsage, Message } from "@alexandernygard/ai-kit"
import {
  isToolActive,
  MessageParts,
  todosOf,
  toolDuration,
  toolLabel,
  type ToolNode,
  type UseChatResult,
  useChat,
  useSessions,
} from "@alexandernygard/ai-kit-react"
import {
  Bubble,
  BubbleContent,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CodeBlock,
  CodeBlockContent,
  cn,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Marker,
  Progress,
  MarkerContent,
  MarkerIcon,
  Message as MessageRow,
  MessageContent,
  MessageFooter,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
  Spinner,
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@alexandernygard/components"
import {
  ArrowUpIcon,
  BrainIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleIcon,
  CodeIcon,
  GitBranchIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react"
import { useState } from "react"

export function App() {
  const [sessionId, setSessionId] = useState<string | undefined>(() => location.hash.slice(1) || undefined)
  const sessions = useSessions()
  const open = (id?: string) => {
    setSessionId(id)
    history.replaceState(null, "", id ? `#${id}` : location.pathname)
  }
  const chat = useChat({
    sessionId,
    newSession: { agent: "concierge" },
    onSessionCreated: (s) => {
      open(s.id)
      void sessions.refresh()
    },
    onFinish: () => void sessions.refresh(),
    getContext: () => ({ locale: navigator.language, screen: window.innerWidth < 768 ? "phone" : "desktop" }),
    clientTools: {
      get_location: () =>
        new Promise((resolve) =>
          navigator.geolocation.getCurrentPosition(
            (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
            () => resolve({ city: "Oslo", note: "Location denied; assuming Oslo." }),
          ),
        ),
    },
  })

  return (
    <div className="grid h-full grid-cols-[16rem_1fr] bg-background text-foreground">
      <aside className="flex flex-col gap-1 border-r p-3">
        <Button variant="outline" className="mb-2 justify-start" onClick={() => open(undefined)}>
          <PlusIcon /> New chat
        </Button>
        {sessions.sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => open(s.id)}
            className={cn(buttonVariants({ variant: "ghost" }), "justify-start truncate", s.id === sessionId && "bg-muted")}
          >
            {s.title ?? "Untitled"}
          </button>
        ))}
      </aside>
      <main className="flex min-h-0 flex-col">
        <Conversation chat={chat} />
        <Composer chat={chat} />
      </main>
    </div>
  )
}

function Conversation({ chat }: { chat: UseChatResult }) {
  const last = chat.path.at(-1)
  const thinking = chat.isRunning && (!last || last.role === "user" || !last.parts.some((p) => p.type === "text" || p.type === "tool"))
  return (
    <MessageScrollerProvider>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="mx-auto w-full max-w-2xl gap-6 p-6">
            {chat.path.length === 0 && (
              <p className="font-heading text-2xl text-muted-foreground">Where to? Try “/plan Bergen”.</p>
            )}
            {chat.path.map((m) => (
              <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === "user"}>
                {m.role === "user" ? <UserMessage message={m} /> : <AssistantMessage message={m} chat={chat} />}
              </MessageScrollerItem>
            ))}
            {thinking && (
              <MessageScrollerItem scrollAnchor={false}>
                <Marker role="status">
                  <MarkerIcon>
                    <Spinner />
                  </MarkerIcon>
                  <MarkerContent className="shimmer">Thinking</MarkerContent>
                </Marker>
              </MessageScrollerItem>
            )}
            {chat.error && <p className="text-sm text-destructive">{chat.error}</p>}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

function UserMessage({ message }: { message: Message }) {
  return (
    <MessageRow align="end">
      <MessageContent>
        <MessageParts
          message={message}
          render={{
            text: (p) => (
              <Bubble>
                <BubbleContent className="whitespace-pre-wrap">{p.text}</BubbleContent>
              </Bubble>
            ),
          }}
        />
      </MessageContent>
    </MessageRow>
  )
}

function AssistantMessage({ message, chat }: { message: Message; chat: UseChatResult }) {
  const v = chat.versions(message.id)
  const done = message.status !== "streaming"
  return (
    <MessageRow align="start">
      <MessageContent className="w-full">
        <MessageParts
          message={message}
          render={{
            text: (p) => (
              <Bubble variant="ghost">
                <BubbleContent className="whitespace-pre-wrap">{p.text}</BubbleContent>
              </Bubble>
            ),
            reasoning: (p) => (
              <Trace>
                <TraceCollapsible>
                  <TraceCollapsibleTrigger>
                    <TraceLine status={p.state === "streaming" ? "running" : undefined}>
                      <TraceIcon>
                        <BrainIcon />
                      </TraceIcon>
                      <TraceTitle>Thought</TraceTitle>
                    </TraceLine>
                  </TraceCollapsibleTrigger>
                  <TraceCollapsibleContent className="text-sm whitespace-pre-wrap text-muted-foreground">{p.text}</TraceCollapsibleContent>
                </TraceCollapsible>
              </Trace>
            ),
            tools: (tools, message) => <ToolTrace tools={tools} message={message} chat={chat} />,
            tool: {
              ask_user: (t) => <AskUser call={t} chat={chat} />,
            },
          }}
        />
        {done && (
          <MessageFooter className="gap-1 text-muted-foreground">
            {v.total > 1 && (
              <>
                <Button size="icon-xs" variant="ghost" disabled={!v.previous} onClick={() => chat.switchBranch(v.previous!)} aria-label="Previous version">
                  <ChevronLeftIcon />
                </Button>
                <span className="text-xs tabular-nums">
                  {v.index + 1} / {v.total}
                </span>
                <Button size="icon-xs" variant="ghost" disabled={!v.next} onClick={() => chat.switchBranch(v.next!)} aria-label="Next version">
                  <ChevronRightIcon />
                </Button>
              </>
            )}
            <Button size="icon-xs" variant="ghost" onClick={() => chat.regenerate(message.id)} aria-label="Regenerate">
              <RefreshCwIcon />
            </Button>
            <Button size="icon-xs" variant="ghost" onClick={() => chat.fork(message.id)} aria-label="Fork from here">
              <GitBranchIcon />
            </Button>
          </MessageFooter>
        )}
      </MessageContent>
    </MessageRow>
  )
}

const icons: Record<string, typeof WrenchIcon> = { run_code: CodeIcon, task: UsersIcon }

function ToolTrace({ tools, message, chat }: { tools: ToolNode[]; message: Message; chat: UseChatResult }) {
  return (
    <Trace>
      {tools.map((t) => {
        const Icon = icons[t.toolName] ?? WrenchIcon
        const seconds = toolDuration(t)
        const status = isToolActive(t, message) ? "running" : t.state === "output-error" || t.state === "denied" ? "error" : undefined
        return (
          <div key={t.toolCallId} className="flex flex-col gap-2">
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine status={status}>
                  <TraceIcon>
                    <Icon />
                  </TraceIcon>
                  <TraceTitle>{toolLabel(t)}</TraceTitle>
                  {seconds !== undefined && <TraceDescription>{seconds.toFixed(1)} s</TraceDescription>}
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent className="flex flex-col gap-2">
                <CodeBlock size="sm">
                  <CodeBlockContent wrap>{JSON.stringify(t.input, null, 2)}</CodeBlockContent>
                </CodeBlock>
                {(t.output !== undefined || t.error) && (
                  <CodeBlock size="sm">
                    <CodeBlockContent wrap>{t.error ?? (typeof t.output === "string" ? t.output : JSON.stringify(t.output, null, 2))}</CodeBlockContent>
                  </CodeBlock>
                )}
                {t.children.length > 0 && <ToolTrace tools={t.children} message={message} chat={chat} />}
                {t.child && <p className="text-sm text-muted-foreground">{t.child.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</p>}
              </TraceCollapsibleContent>
            </TraceCollapsible>
            {t.state === "awaiting-approval" && <Approval call={t} chat={chat} />}
          </div>
        )
      })}
    </Trace>
  )
}

function Approval({ call, chat }: { call: ToolNode; chat: UseChatResult }) {
  return (
    <Card size="sm" className="max-w-md">
      <CardHeader>
        <CardTitle>{call.title ?? call.toolName}?</CardTitle>
        <CardDescription>The concierge wants to do this. Nothing happens until you approve.</CardDescription>
      </CardHeader>
      <CardContent>
        <CodeBlock size="sm">
          <CodeBlockContent wrap>{JSON.stringify(call.input, null, 2)}</CodeBlockContent>
        </CodeBlock>
      </CardContent>
      <CardFooter className="gap-2">
        <Button size="sm" onClick={() => chat.approve(call.toolCallId)}>
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => chat.approve(call.toolCallId, { remember: true })}>
          Always allow
        </Button>
        <Button size="sm" variant="ghost" onClick={() => chat.deny(call.toolCallId)}>
          Deny
        </Button>
      </CardFooter>
    </Card>
  )
}

/** `ask_user` rendered as a Questionnaire. Its answers go back as the tool's output. */
function AskUser({ call, chat }: { call: ToolNode; chat: UseChatResult }) {
  const questions = ((call.input as { questions?: AskUserQuestion[] } | undefined)?.questions ?? []).slice(0, 4)
  if (call.state !== "awaiting-output") {
    const answers = (call.output as { answers?: Record<string, string | string[]> } | undefined)?.answers ?? {}
    return (
      <Trace>
        <TraceLine>
          <TraceIcon>
            <CheckIcon />
          </TraceIcon>
          <TraceTitle>{Object.values(answers).flat().join(", ") || "Answered"}</TraceTitle>
        </TraceLine>
      </Trace>
    )
  }
  const items = questions.map((q, i) => ({ name: `q${i}`, required: true, choices: (q.options ?? []).map((o) => ({ value: o.label })) }))
  return (
    <Questionnaire
      className="max-w-lg"
      items={items}
      shortcuts="letters"
      onSubmit={(e) => {
        e.preventDefault()
        const data = new FormData(e.currentTarget)
        const answers = Object.fromEntries(
          questions.map((q, i) => [q.question, q.multiSelect ? data.getAll(`q${i}`).map(String) : String(data.get(`q${i}`) ?? "")]),
        )
        void chat.submitToolOutput(call.toolCallId, { answers })
      }}
    >
      {questions.length > 1 && <QuestionnaireProgress />}
      {questions.map((q, i) => (
        <QuestionnaireItem key={i} name={`q${i}`} required multiple={q.multiSelect}>
          <QuestionnaireTitle>{q.question}</QuestionnaireTitle>
          <QuestionnaireChoices>
            {(q.options ?? []).map((o) => (
              <QuestionnaireChoice key={o.label} value={o.label}>
                {o.label}
                {o.description && <QuestionnaireChoiceDescription>{o.description}</QuestionnaireChoiceDescription>}
              </QuestionnaireChoice>
            ))}
            <QuestionnaireInput aria-label="Something else" placeholder="Something else…" />
          </QuestionnaireChoices>
        </QuestionnaireItem>
      ))}
      <QuestionnaireActions>
        {questions.length > 1 && <QuestionnairePrevious />}
        {questions.length > 1 && <QuestionnaireNext>Next</QuestionnaireNext>}
        <QuestionnaireSubmit>Send</QuestionnaireSubmit>
      </QuestionnaireActions>
    </Questionnaire>
  )
}

/** How full the model's context window is, with a breakdown on hover. */
function ContextMeter({ usage }: { usage: ContextUsage }) {
  const pct = Math.round(usage.ratio * 100)
  const b = usage.breakdown
  const detail = b
    ? `System ${b.system}, tools ${b.tools}, messages ${b.messages} tokens${b.context.length ? `; context: ${b.context.map((c) => `${c.name} ${c.tokens}`).join(", ")}` : ""}`
    : undefined
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" title={detail}>
      <Progress value={pct} className="h-1 w-24" />
      <span className="tabular-nums">
        {pct < 1 ? "<1" : pct}% of context ({usage.tokens.toLocaleString()} / {usage.window.toLocaleString()} tokens)
      </span>
    </div>
  )
}

function Composer({ chat }: { chat: UseChatResult }) {
  const [draft, setDraft] = useState("")
  const todos = todosOf(chat.path)
  const submit = () => {
    if (!draft.trim() || chat.isRunning) return
    void chat.send(draft)
    setDraft("")
  }
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
      {todos && (
        <ul className="flex flex-col gap-1 text-sm">
          {todos.map((t) => (
            <li key={t.content} className={cn("flex items-center gap-2", t.status === "completed" && "text-muted-foreground line-through")}>
              {t.status === "completed" ? <CheckIcon className="size-3.5" /> : t.status === "in_progress" ? <Spinner className="size-3.5" /> : <CircleIcon className="size-3.5" />}
              {t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
            </li>
          ))}
        </ul>
      )}
      {chat.contextUsage && <ContextMeter usage={chat.contextUsage} />}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <InputGroup>
          <InputGroupTextarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={chat.status === "awaiting-input" ? "Answer above, or say something else" : "Message the concierge"}
            className="min-h-12"
          />
          <InputGroupAddon align="block-end">
            {chat.isRunning ? (
              <InputGroupButton type="button" size="icon-xs" variant="default" className="ml-auto rounded-full" aria-label="Stop" onClick={() => chat.stop()}>
                <SquareIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="submit" size="icon-xs" variant="default" className="ml-auto rounded-full" aria-label="Send" disabled={!draft.trim()}>
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  )
}
