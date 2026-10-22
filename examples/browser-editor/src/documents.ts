import { useSyncExternalStore } from "react"

export interface Doc {
  id: string
  title: string
  text: string
}

const KEY = "browser-editor:documents"

const starter: Doc[] = [
  {
    id: "team",
    title: "Team",
    text: JSON.stringify({ team: "Platform", members: [{ name: "Ada", role: "lead" }, { name: "Linus", role: "engineer" }] }, null, 2),
  },
  {
    id: "inventory",
    title: "Inventory",
    text: JSON.stringify({ items: [{ sku: "A-1", name: "Desk", stock: 4 }, { sku: "B-2", name: "Chair", stock: 12 }] }, null, 2),
  },
]

function load(): Doc[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as Doc[]
  } catch {
    // Fall back to the starter documents.
  }
  return starter
}

let docs = load()
const listeners = new Set<() => void>()

/** The app's documents, in localStorage. The assistant's tools write here too. */
export const documents = {
  all: () => docs,
  get: (id: string) => docs.find((d) => d.id === id),
  update(id: string, text: string) {
    docs = docs.map((d) => (d.id === id ? { ...d, text } : d))
    try {
      localStorage.setItem(KEY, JSON.stringify(docs))
    } catch {
      // Keep the edit for this page only.
    }
    for (const fn of listeners) fn()
  },
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

export function useDocuments(): Doc[] {
  return useSyncExternalStore(documents.subscribe, documents.all, documents.all)
}
