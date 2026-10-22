import { defineAgent, defineContext, sourceTools, type SourceFiles, type ToolContext } from "@alexandernygard/ai-kit"
import { claudeFromSettings } from "@alexandernygard/ai-kit-anthropic"
import { type AssistantSettings, createBrowserKit, settingsStore } from "@alexandernygard/ai-kit-react"
import { documents } from "./documents"

/*
 * Everything ai-kit needs for a browser-only editor: the user's settings, one agent with the
 * document tools and a self-check, and a kit that keeps conversations in IndexedDB.
 */

export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]

export const settings = settingsStore<AssistantSettings>({ model: MODELS[0]!, effort: "medium" }, { key: "browser-editor:settings" })

/** The open document, from what the panel sends with each message. */
const documentOf = (ctx: ToolContext): SourceFiles => {
  const id = String(ctx.clientContext?.documentId ?? "")
  return {
    read: () => documents.get(id)?.text,
    write: (_, text) => documents.update(id, text),
  }
}

/** The self-check: tell the model whether the document is still valid JSON, and where it breaks. */
function validate(text: string): string {
  try {
    JSON.parse(text)
    return "The document is valid JSON."
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const at = /position (\d+)/.exec(message)
    const line = at ? text.slice(0, Number(at[1])).split("\n").length : undefined
    return `The document is no longer valid JSON${line ? ` (line ${line})` : ""}: ${message}. Fix it.`
  }
}

const editor = defineAgent({
  name: "editor",
  model: claudeFromSettings(settings.get),
  instructions: [
    "You help the user edit a JSON document in their browser.",
    "The current document is attached to each message. Make small, targeted changes with edit_file; use write_file only to restructure the whole document.",
    "After each change the tool result says whether the document is still valid JSON. If it isn't, fix it before you answer.",
    "Answer in a sentence or two. Don't repeat the document back.",
  ].join("\n"),
  tools: sourceTools({
    files: documentOf,
    defaultPath: "document.json",
    checkPath: (path) => (path === "document.json" ? undefined : "There is one file: document.json."),
    feedback: ({ after }) => validate(after),
  }),
  contextProviders: [
    defineContext({
      name: "document",
      refresh: "step",
      get: ({ clientContext }) => {
        const doc = documents.get(String(clientContext?.documentId ?? ""))
        return doc ? `document.json ("${doc.title}"):\n${doc.text}` : undefined
      },
    }),
  ],
})

export const { kit, transport } = createBrowserKit({ agents: [editor], database: "browser-editor" })
