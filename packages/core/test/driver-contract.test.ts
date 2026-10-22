import { describe, it } from "vitest"
import { driverContract, type DriverScenario, mockModel, type MockResponse } from "../src/testing"

const scripts: Record<DriverScenario, MockResponse> = {
  text: { text: "pong" },
  "tool-call": { toolCalls: [{ name: "get_weather", input: { city: "Oslo" } }] },
  "tool-result": { text: "It's 4 degrees in Oslo." },
  abort: { text: Array.from({ length: 200 }, (_, i) => i + 1).join("\n") },
  error: { error: "boom" },
}

describe("mockModel driver contract", () => {
  for (const c of driverContract((s) => mockModel([scripts[s]], { chunkSize: 4 }))) it(c.name, c.run)
})
