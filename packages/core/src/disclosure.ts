import { jsonSchema } from "./schema"
import { type Tool, type Toolkit, tool } from "./tools"

/**
 * Progressive tool disclosure. Deferred tools (and deferred toolkits) stay out of the model's
 * tool list. The agent gets `search_tools`, which finds tools by what they do and loads the
 * matches for the rest of the session. Same idea as Anthropic's tool search tool, but it works
 * with every model.
 */

export interface ToolSearchHit {
  name: string
  description: string
  toolkit?: string
  score: number
}

/** Swap in your own search, such as embeddings. */
export interface ToolIndex {
  search(query: string, entries: ToolIndexEntry[], limit: number): ToolSearchHit[] | Promise<ToolSearchHit[]>
}

export interface ToolIndexEntry {
  tool: Tool
  toolkit?: Toolkit
}

export const ACTIVE_TOOLS_KEY = "ai-kit.activeTools"

const tokenize = (s: string) =>
  s
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)

/** Keyword scoring over names, keywords and descriptions. No dependencies, fast enough for thousands of tools. */
export const keywordIndex: ToolIndex = {
  search(query, entries, limit) {
    const q = tokenize(query)
    if (!q.length) return []
    const hits: ToolSearchHit[] = []
    for (const { tool: t, toolkit } of entries) {
      const fields: Array<[string[], number]> = [
        [tokenize(t.name), 3],
        [(t.keywords ?? []).flatMap(tokenize), 2],
        [tokenize(t.description), 1],
        [toolkit ? tokenize(`${toolkit.name} ${toolkit.description}`) : [], 0.5],
      ]
      let score = 0
      for (const term of q) {
        for (const [words, weight] of fields) {
          if (words.includes(term)) score += weight
          else if (words.some((w) => w.startsWith(term) || term.startsWith(w))) score += weight * 0.5
        }
      }
      if (t.name.toLowerCase() === query.toLowerCase()) score += 10
      if (score > 0) hits.push({ name: t.name, description: t.description, toolkit: toolkit?.name, score })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  },
}

export interface DisclosureOptions {
  index?: ToolIndex
  /** Results per search. Default 5. */
  maxResults?: number
}

/** The `search_tools` tool. `activate` loads names into the session. */
export function searchToolsTool(
  entries: () => ToolIndexEntry[],
  toolkits: Toolkit[],
  activate: (names: string[]) => void,
  options: DisclosureOptions = {},
): Tool {
  const index = options.index ?? keywordIndex
  const kitNames = toolkits.map((k) => k.name)
  return tool({
    name: "search_tools",
    description: [
      "Find and load more tools. Describe what you need to do; matching tools are loaded and you can call them next.",
      kitNames.length ? `Pass \`toolkit\` to load a whole toolkit (${kitNames.join(", ")}).` : "",
      "Pass `names` to load tools whose names you already know.",
    ]
      .filter(Boolean)
      .join(" "),
    input: jsonSchema<{ query?: string; toolkit?: string; names?: string[] }>({
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to do, in a few words" },
        toolkit: kitNames.length ? { type: "string", enum: kitNames } : { type: "string" },
        names: { type: "array", items: { type: "string" } },
      },
    }),
    readOnly: true,
    codeMode: false,
    title: (i) => (i.query ? `Searching tools for "${i.query}"` : i.toolkit ? `Loading ${i.toolkit}` : "Loading tools"),
    async execute({ query, toolkit: kitName, names }) {
      const all = entries()
      let hits: ToolSearchHit[] = []
      if (kitName) {
        hits = all
          .filter((e) => e.toolkit?.name === kitName)
          .map((e) => ({ name: e.tool.name, description: e.tool.description, toolkit: kitName, score: 1 }))
      }
      if (names?.length) {
        const known = new Map(all.map((e) => [e.tool.name, e]))
        for (const n of names) {
          const e = known.get(n)
          if (e) hits.push({ name: n, description: e.tool.description, toolkit: e.toolkit?.name, score: 1 })
        }
      }
      if (query) hits.push(...(await index.search(query, all, options.maxResults ?? 5)))
      const unique = [...new Map(hits.map((h) => [h.name, h])).values()]
      if (!unique.length) return "No matching tools. Try other words, or do the task with the tools you have."
      activate(unique.map((h) => h.name))
      return {
        loaded: unique.map((h) => ({ name: h.name, description: h.description, toolkit: h.toolkit })),
        note: "These tools are now available.",
      }
    },
  })
}

/** The system prompt section for deferred toolkits. */
export function toolkitsPrompt(toolkits: Toolkit[], hasDeferredTools: boolean): string {
  const deferred = toolkits.filter((k) => k.defer)
  if (!deferred.length && !hasDeferredTools) return ""
  return [
    "# More tools",
    "Some tools aren't loaded yet. Use `search_tools` to find and load them when your current tools can't do the job.",
    ...deferred.map((k) => `- ${k.name} (${k.tools.length} tools): ${k.description}`),
  ].join("\n")
}
