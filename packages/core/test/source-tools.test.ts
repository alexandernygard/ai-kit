import { describe, expect, it } from "vitest"
import { createKit, defineAgent, memoryFiles, sourceTools, type SourceChange, type ToolPart } from "../src/index"
import { mockModel } from "../src/testing"

const results = (parts: ToolPart[]) => parts.map((p) => ({ state: p.state, output: p.output ?? p.error }))

async function run(calls: Array<{ name: string; input: unknown }>, opts: Parameters<typeof sourceTools>[0]) {
  const model = mockModel([{ toolCalls: calls }, { text: "Done." }])
  const kit = createKit({ agents: [defineAgent({ name: "a", model, tools: sourceTools(opts) })] })
  const r = await (await kit.createSession()).send("go").result
  return { parts: r.message.parts.filter((p): p is ToolPart => p.type === "tool"), model }
}

describe("sourceTools", () => {
  it("reads, edits a unique match and writes, with feedback after each change", async () => {
    const files = memoryFiles({ "main.ts": "const a = 1\nconst b = 2\n" })
    const changes: SourceChange[] = []
    const { parts, model } = await run(
      [
        { name: "read_file", input: { path: "main.ts" } },
        { name: "edit_file", input: { path: "main.ts", old_string: "const b = 2", new_string: "const b = 3", summary: "Bump b" } },
        { name: "write_file", input: { path: "data.csv", content: "x,y\n1,2" } },
      ],
      {
        files,
        feedback: (c) => {
          changes.push(c)
          return c.path.endsWith(".ts") ? "Compiles without errors." : undefined
        },
      },
    )
    expect(results(parts)).toEqual([
      { state: "output-available", output: "const a = 1\nconst b = 2\n" },
      { state: "output-available", output: "Edited main.ts at line 2.\n\nCompiles without errors." },
      { state: "output-available", output: "Created data.csv (2 lines)." },
    ])
    expect(parts[1]!.title).toBe("Bump b")
    expect(files.files.get("main.ts")).toBe("const a = 1\nconst b = 3\n")
    expect(changes.map((c) => [c.tool, c.path, c.before === undefined])).toEqual([
      ["edit", "main.ts", false],
      ["write", "data.csv", true],
    ])
    // The model saw the feedback.
    expect(JSON.stringify(model.requests[1]!.messages)).toContain("Compiles without errors.")
  })

  it("rejects missing, ambiguous and unknown edits without writing", async () => {
    const files = memoryFiles({ "a.ts": "x\nx\n" })
    const { parts } = await run(
      [
        { name: "edit_file", input: { path: "a.ts", old_string: "x", new_string: "y" } },
        { name: "edit_file", input: { path: "a.ts", old_string: "z", new_string: "y" } },
        { name: "edit_file", input: { path: "b.ts", old_string: "x", new_string: "y" } },
      ],
      { files },
    )
    expect(results(parts).map((r) => r.state)).toEqual(["output-error", "output-error", "output-error"])
    expect(String(parts[0]!.error)).toContain("appears 2 times")
    expect(String(parts[1]!.error)).toContain("wasn't found")
    expect(String(parts[2]!.error)).toContain("Files: a.ts")
    expect(files.files.get("a.ts")).toBe("x\nx\n")
  })

  it("uses a default path, checks paths and reads line ranges", async () => {
    const files = memoryFiles({ "doc.ts": "1\n2\n3\n4" })
    const { parts } = await run(
      [
        { name: "read_file", input: { offset: 2, limit: 2 } },
        { name: "write_file", input: { path: "evil.sh", content: "rm" } },
      ],
      { files, defaultPath: "doc.ts", checkPath: (p, t) => (t === "write" && !p.endsWith(".ts") ? "Only .ts files can be written." : undefined) },
    )
    expect(parts[0]!.output).toBe("Lines 2-3 of 4:\n2\n3")
    expect(parts[1]).toMatchObject({ state: "output-error", error: "Only .ts files can be written." })
  })
})
