import { describe, expect, it } from "vitest"
import { parsePartialJson } from "../src/index"

describe("parsePartialJson", () => {
  it.each([
    ['{"path":"a.ts","content":"line 1\\nli', { path: "a.ts", content: "line 1\nli" }],
    ['{"path":"a.ts","con', { path: "a.ts" }],
    ['{"path":"a.ts",', { path: "a.ts" }],
    ['{"path":', {}],
    ['{"n": 12', { n: 12 }],
    ['{"ok": tr', {}],
    ['{"items":[1,2,{"a":"b', { items: [1, 2, { a: "b" }] }],
    ['{"s":"caf\\u00', { s: "caf" }],
    ['{"s":"a\\', { s: "a" }],
    ["", undefined],
    ["not json", undefined],
  ])("%s", (text, expected) => {
    expect(parsePartialJson(text)).toEqual(expected)
  })

  it("parses every prefix of a document without throwing, and the whole of it exactly", () => {
    const doc = { path: "src/app.ts", content: 'const x = "quoted \\"thing\\""\n\tif (a < b) { run() }\nemoji: 🦊', edits: [{ line: 3, ok: true, n: -1.5e3 }, null] }
    const text = JSON.stringify(doc)
    let longest = 0
    for (let i = 0; i <= text.length; i++) {
      const v = parsePartialJson(text.slice(0, i)) as { content?: string } | undefined
      if (typeof v?.content === "string") {
        // The streamed document only grows.
        expect(v.content.length).toBeGreaterThanOrEqual(longest)
        longest = v.content.length
      }
    }
    expect(parsePartialJson(text)).toEqual(doc)
  })
})
