/**
 * Parse JSON that's still streaming in: close the open string, drop a dangling key or partial
 * literal, and close open objects and arrays. Returns `undefined` when nothing usable has arrived.
 *
 * ```ts
 * parsePartialJson('{"path":"a.ts","content":"line 1\\nli') // { path: "a.ts", content: "line 1\nli" }
 * ```
 */
export function parsePartialJson(text: string): unknown {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === "{") stack.push("}")
    else if (ch === "[") stack.push("]")
    else if (ch === "}" || ch === "]") stack.pop()
  }

  let body = text
  if (inString) {
    // A cut-off escape (`\` or `\u00`) can't be closed; drop it.
    body = body.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "") + '"'
  }
  const closers = stack.reverse().join("")
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return JSON.parse(body + closers)
    } catch {
      const trimmed = body
        .replace(/\s+$/, "")
        // A key with no value yet: `{"a": 1, "b"` or `{"b":`.
        .replace(/([{,])\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, "$1")
        // A value cut off after the colon, or a partial literal or number.
        .replace(/:\s*$/, "")
        .replace(/(^|[^"\w])[-+.\w]+$/, "$1")
        .replace(/,\s*$/, "")
      if (trimmed === body) return undefined
      body = trimmed
    }
  }
  return undefined
}
