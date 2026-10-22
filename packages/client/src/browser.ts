import { createKit, type Kit, type KitOptions, type KV, kvStore, memoryKV, type ModelSettings, type SessionInfo, type Store } from "@alexandernygard/ai-kit"
import { directTransport, type DirectTransportOptions, type Transport } from "./transport"

/*
 * Browser-only apps: the agent loop runs in the page with the user's own API key, sessions live
 * in IndexedDB, and the UI talks to the kit through `directTransport`.
 */

// ---------------------------------------------------------------------------------------------
// IndexedDB

/** A `KV` on IndexedDB, for `kvStore`. One object store of string values. */
export function indexedDBKV(options: { database?: string; storeName?: string; indexedDB?: IDBFactory } = {}): KV {
  const name = options.storeName ?? "kv"
  let db: Promise<IDBDatabase> | undefined
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB
      const req = factory.open(options.database ?? "ai-kit", 1)
      req.onupgradeneeded = () => req.result.createObjectStore(name)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }))
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const tx = (await open()).transaction(name, mode)
    const req = fn(tx.objectStore(name))
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error)
    })
  }
  return {
    get: (key) => run("readonly", (s) => s.get(key) as IDBRequest<string | undefined>),
    set: async (key, value) => void (await run("readwrite", (s) => s.put(value, key))),
    delete: async (key) => void (await run("readwrite", (s) => s.delete(key))),
    list: async (prefix) => (await run("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)))).map(String),
  }
}

// ---------------------------------------------------------------------------------------------
// Settings

/** What the user picks in a settings panel. Kept in localStorage. */
export interface AssistantSettings {
  /** The user's own Anthropic API key. */
  apiKey?: string
  model: string
  effort?: ModelSettings["effort"]
}

/** A small observable store. `subscribe` follows the Svelte contract; `getSnapshot` suits `useSyncExternalStore`. */
export interface SettingsStore<S> {
  get(): S
  getSnapshot(): S
  set(patch: Partial<S>): void
  subscribe(fn: (s: S) => void): () => void
}

/**
 * Settings saved in localStorage under `key`, merged over `defaults`. Falls back to memory when
 * storage isn't available (private mode, SSR).
 */
export function settingsStore<S extends object>(defaults: S, options: { key?: string; storage?: Pick<Storage, "getItem" | "setItem"> } = {}): SettingsStore<S> {
  const key = options.key ?? "ai-kit:settings"
  const storage = options.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined)
  let state = defaults
  try {
    const raw = storage?.getItem(key)
    if (raw) state = { ...defaults, ...(JSON.parse(raw) as Partial<S>) }
  } catch {
    // Unreadable settings: start from the defaults.
  }
  const listeners = new Set<(s: S) => void>()
  return {
    get: () => state,
    getSnapshot: () => state,
    set(patch) {
      state = { ...state, ...patch }
      try {
        storage?.setItem(key, JSON.stringify(state))
      } catch {
        // Storage full or blocked: keep the settings for this page only.
      }
      for (const fn of listeners) fn(state)
    },
    subscribe(fn) {
      listeners.add(fn)
      fn(state)
      return () => listeners.delete(fn)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Kit

export interface BrowserKitOptions<Ctx> extends KitOptions<Ctx> {
  /** IndexedDB database name for sessions. Default `ai-kit`. Ignored when `store` is set. */
  database?: string
  transport?: DirectTransportOptions<Ctx>
}

/**
 * A kit that runs in the browser: sessions in IndexedDB (memory when it isn't available) and a
 * `directTransport` for `Chat`, `useChat` and `useAssistant`.
 *
 * ```ts
 * const settings = settingsStore<AssistantSettings>({ model: "claude-opus-5-5" })
 * const { kit, transport } = createBrowserKit({
 *   agents: [defineAgent({ name: "assistant", model: claudeFromSettings(settings.get), tools: sourceTools({ ... }) })],
 * })
 * ```
 */
export function createBrowserKit<Ctx = any>(options: BrowserKitOptions<Ctx>): { kit: Kit<Ctx>; transport: Transport; store: Store } {
  const { database, transport: transportOptions, ...kitOptions } = options
  const store = kitOptions.store ?? kvStore(typeof indexedDB !== "undefined" ? indexedDBKV({ database }) : memoryKV())
  // In-process runs don't need an event log to reconnect to.
  const kit = createKit<Ctx>({ persistEvents: false, ...kitOptions, store })
  return { kit, transport: directTransport(kit, transportOptions), store }
}

// ---------------------------------------------------------------------------------------------
// Per-document sessions

/** The newest session for a document, found by `metadata.documentId`. */
export async function findDocumentSession(transport: Transport, documentId: string, agent?: string): Promise<SessionInfo | undefined> {
  let cursor: string | undefined
  do {
    const page = await transport.listSessions({ agent, cursor, limit: 100 })
    const hit = page.sessions.find((s) => s.metadata?.documentId === documentId)
    if (hit) return hit
    cursor = page.nextCursor
  } while (cursor)
  return undefined
}
