import { describe, expect, it } from "vitest"
import { claude, claudeModelInfo } from "../src/index"

describe("model capability table", () => {
  it.each([
    ["claude-opus-5-5", { fallbacks: true, compaction: true, systemMessages: true, toolSearch: true, preservedThinking: true, forcedToolChoice: false }],
    ["claude-opus-5", { fallbacks: true, compaction: true, systemMessages: true, toolSearch: true }],
    ["claude-sonnet-5", { fallbacks: true, compaction: true, toolSearch: true }],
    ["claude-haiku-5-5", { fallbacks: true, compaction: true, preservedThinking: true, toolSearch: true }],
    ["claude-fable-5-1", { fallbacks: true, compaction: true, systemMessages: true, toolSearch: true, preservedThinking: true, forcedToolChoice: false }],
    ["claude-mythos-preview", { compaction: true }],
    ["claude-opus-4-8", { compaction: true, systemMessages: true, toolSearch: true }],
    ["claude-haiku-4-5", { toolSearch: true }],
  ])("%s", (model, expected) => {
    expect(claudeModelInfo(model)).toEqual(expected)
  })

  it("matches dated and provider-prefixed ids by their longest prefix", () => {
    expect(claudeModelInfo("claude-opus-5-5-20260301")).toEqual(claudeModelInfo("claude-opus-5-5"))
    expect(claudeModelInfo("us.anthropic.claude-sonnet-5-5-v1:0")).toEqual(claudeModelInfo("claude-sonnet-5-5"))
    expect(claudeModelInfo("claude-opus-5-1")).toEqual(claudeModelInfo("claude-opus-5"))
  })

  it("doesn't match a longer version number", () => {
    expect(claudeModelInfo("claude-opus-4-50")).toEqual({})
    expect(claudeModelInfo("claude-3-haiku")).toEqual({})
  })

  it("sets the driver's defaults", () => {
    expect(claude("claude-opus-5-5").capabilities).toMatchObject({ contextManagement: true, toolSearch: true, forcedToolChoice: false })
    expect(claude("claude-3-haiku").capabilities).toMatchObject({ contextManagement: false, toolSearch: false, forcedToolChoice: true })
  })
})
