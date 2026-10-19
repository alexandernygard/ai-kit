const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** Random, URL-safe id. `prefix` makes ids readable in logs: `msg_3fK9...`. */
export function createId(prefix?: string, size = 16): string {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  let id = ""
  for (const b of bytes) id += alphabet[b % alphabet.length]
  return prefix ? `${prefix}_${id}` : id
}

export const now = (): number => Date.now()
