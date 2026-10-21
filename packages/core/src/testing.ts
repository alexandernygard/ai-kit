import type { ModelDriver, ModelEvent, ModelRequest } from "./driver"
import { emptyUsage, type Usage } from "./usage"

/**
 * Test doubles. `mockModel` replays scripted responses so you can test agents, tools,
 * approvals and UIs without calling a provider.
 *
 * ```ts
 * const model = mockModel([
 *   { toolCalls: [{ name: "get_weather", input: { city: "Oslo" } }] },
 *   { text: "It's 4 degrees in Oslo." },
 * ])
 * ```
 */
export type MockResponse =
  | {
      text?: string
      reasoning?: string
      toolCalls?: Array<{ name: string; input: unknown; id?: string }>
      finishReason?: "stop" | "tool-calls" | "length" | "content-filter"
      usage?: Partial<Usage>
      /** Throw instead of answering. */
      error?: string
    }
  | ((request: ModelRequest, index: number) => MockResponse)

export interface MockModel extends ModelDriver {
  /** Every request the model got, in order. */
  readonly requests: ModelRequest[]
}

export function mockModel(
  responses: MockResponse[],
  options: { provider?: string; modelId?: string; capabilities?: ModelDriver["capabilities"]; chunkSize?: number } = {},
): MockModel {
  const requests: ModelRequest[] = []
  let i = 0
  return {
    kind: "model",
    provider: options.provider ?? "mock",
    modelId: options.modelId ?? "mock-1",
    capabilities: options.capabilities,
    requests,
    async *stream(request): AsyncIterable<ModelEvent> {
      requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest)
      const index = i++
      let r = responses[Math.min(index, responses.length - 1)]
      if (!r) r = { text: "" }
      if (typeof r === "function") r = r(request, index)
      if (typeof r === "function") throw new Error("A mock response function must return a response object")
      if (r.error) throw new Error(r.error)
      if (r.reasoning) {
        yield { type: "reasoning-delta", id: "r0", delta: r.reasoning }
        yield { type: "reasoning-end", id: "r0" }
      }
      if (r.text) {
        const size = options.chunkSize ?? 8
        for (let k = 0; k < r.text.length; k += size) {
          if (request.signal?.aborted) return
          yield { type: "text-delta", id: "t0", delta: r.text.slice(k, k + size) }
          await Promise.resolve()
        }
        yield { type: "text-end", id: "t0" }
      }
      for (const [n, c] of (r.toolCalls ?? []).entries()) {
        const id = c.id ?? `call_${index}_${n}`
        yield { type: "tool-input-start", toolCallId: id, toolName: c.name }
        yield { type: "tool-input-delta", toolCallId: id, delta: JSON.stringify(c.input) }
        yield { type: "tool-call", toolCallId: id, toolName: c.name, input: c.input }
      }
      yield {
        type: "finish",
        finishReason: r.finishReason ?? (r.toolCalls?.length ? "tool-calls" : "stop"),
        usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5, ...r.usage },
      }
    },
  }
}

/** Collect a run's events into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iterable) out.push(x)
  return out
}
