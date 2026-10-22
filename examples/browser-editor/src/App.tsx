import { textOf, type ToolPart } from "@alexandernygard/ai-kit"
import { toolInput, toolLabel, type UseAssistantResult, useAssistant, useSettings } from "@alexandernygard/ai-kit-react"
import {
  Bubble,
  BubbleContent,
  Button,
  cn,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Label,
  NativeSelect,
  NativeSelectOption,
  Spinner,
  Textarea,
} from "@alexandernygard/components"
import { useState } from "react"
import { MODELS, settings, transport } from "./assistant"
import { documents, useDocuments } from "./documents"

export function App() {
  const docs = useDocuments()
  const [openId, setOpenId] = useState(docs[0]!.id)
  const doc = docs.find((d) => d.id === openId)!
  const chat = useAssistant({ transport, documentId: doc.id, getContext: () => ({ documentId: doc.id }) })
  const preview = livePreview(chat)

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[12rem_1fr_24rem]">
      <nav className="flex flex-col gap-1 border-b p-3 md:border-r md:border-b-0">
        {docs.map((d) => (
          <Button key={d.id} variant={d.id === openId ? "secondary" : "ghost"} className="justify-start" onClick={() => setOpenId(d.id)}>
            {d.title}
          </Button>
        ))}
      </nav>

      <main className="flex min-h-0 flex-col gap-2 p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {preview ? (
            <>
              <Spinner className="size-3.5" /> The assistant is writing…
            </>
          ) : (
            "document.json"
          )}
        </div>
        <Textarea
          className="min-h-0 flex-1 resize-none font-mono text-sm"
          value={preview ?? doc.text}
          readOnly={!!preview}
          onChange={(e) => documents.update(doc.id, e.target.value)}
        />
      </main>

      <aside className="flex min-h-0 flex-col border-t md:border-t-0 md:border-l">
        <SettingsPanel />
        <Messages chat={chat} />
        <Composer chat={chat} />
      </aside>
    </div>
  )
}

/** While the model streams a `write_file`, show what it has written so far. */
function livePreview(chat: UseAssistantResult): string | undefined {
  const last = chat.path.at(-1)
  const writing = last?.parts.findLast((p): p is ToolPart => p.type === "tool" && p.toolName === "write_file" && p.state === "input-streaming")
  return writing ? toolInput<{ content: string }>(writing)?.content : undefined
}

function SettingsPanel() {
  const [s, set] = useSettings(settings)
  return (
    <div className="flex flex-col gap-2 border-b p-3">
      <Label htmlFor="api-key">Anthropic API key</Label>
      <Input id="api-key" type="password" placeholder="sk-ant-…" value={s.apiKey ?? ""} onChange={(e) => set({ apiKey: e.target.value || undefined })} />
      <div className="flex gap-2">
        <NativeSelect aria-label="Model" value={s.model} onChange={(e) => set({ model: e.target.value })}>
          {MODELS.map((m) => (
            <NativeSelectOption key={m} value={m}>
              {m}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Effort" value={s.effort ?? "medium"} onChange={(e) => set({ effort: e.target.value as typeof s.effort })}>
          {(["low", "medium", "high"] as const).map((e) => (
            <NativeSelectOption key={e} value={e}>
              {e}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <p className="text-xs text-muted-foreground">Your key stays in this browser and goes only to the Claude API.</p>
    </div>
  )
}

function Messages({ chat }: { chat: UseAssistantResult }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {chat.status === "loading" && <Spinner className="mx-auto" />}
      {chat.path.map((m) => (
        <div key={m.id} className={cn("flex flex-col gap-1", m.role === "user" && "items-end")}>
          {m.parts
            .filter((p): p is ToolPart => p.type === "tool")
            .map((t) => (
              <span key={t.toolCallId} className={cn("text-xs text-muted-foreground", t.state === "output-error" && "text-destructive")}>
                {toolLabel(t)}
              </span>
            ))}
          {textOf(m) && (
            <Bubble variant={m.role === "user" ? "default" : "ghost"}>
              <BubbleContent className="whitespace-pre-wrap">{textOf(m)}</BubbleContent>
            </Bubble>
          )}
        </div>
      ))}
      {chat.error && <p className="text-sm text-destructive">{chat.error}</p>}
    </div>
  )
}

function Composer({ chat }: { chat: UseAssistantResult }) {
  const [draft, setDraft] = useState("")
  const submit = () => {
    if (!draft.trim() || chat.isRunning || chat.status === "loading") return
    void chat.send(draft)
    setDraft("")
  }
  return (
    <form
      className="p-3"
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
          placeholder="Ask for a change"
          className="min-h-12"
        />
        <InputGroupAddon align="block-end">
          {chat.isRunning ? (
            <InputGroupButton type="button" size="xs" className="ml-auto" onClick={() => chat.stop()}>
              Stop
            </InputGroupButton>
          ) : (
            <InputGroupButton type="submit" size="xs" variant="default" className="ml-auto" disabled={!draft.trim()}>
              Send
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
