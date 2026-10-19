import type { AgentEvent, EventEnvelope } from "./events"

/**
 * A run's events, kept so any number of readers can join at any point, including after the
 * run ended (reconnects read from a `seq`).
 */
export class EventHub {
  private readonly buffer: EventEnvelope[] = []
  private waiters: Array<() => void> = []
  private closed = false

  constructor(readonly runId: string) {}

  get done() {
    return this.closed
  }

  get size() {
    return this.buffer.length
  }

  push(event: AgentEvent): EventEnvelope {
    if (this.closed) throw new Error("EventHub is closed")
    const env = { seq: this.buffer.length, runId: this.runId, event }
    this.buffer.push(env)
    this.wake()
    return env
  }

  close() {
    this.closed = true
    this.wake()
  }

  private wake() {
    const w = this.waiters
    this.waiters = []
    for (const fn of w) fn()
  }

  /** Envelopes with `seq` greater than `after`, live until the run ends. */
  async *subscribe(after = -1, signal?: AbortSignal): AsyncGenerator<EventEnvelope> {
    let i = after + 1
    while (!signal?.aborted) {
      while (i < this.buffer.length) yield this.buffer[i++]!
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        signal?.addEventListener("abort", () => resolve(), { once: true })
      })
    }
  }

  snapshot(after = -1): EventEnvelope[] {
    return this.buffer.slice(after + 1)
  }
}

/** A queue you push into from callbacks and read with `for await`. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<(r: IteratorResult<T>) => void> = []
  private ended = false
  private failure: unknown

  push(item: T) {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  end(error?: unknown) {
    this.ended = true
    this.failure = error
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.ended) {
          if (this.failure) return Promise.reject(this.failure)
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Server-sent events

const encoder = new TextEncoder()

export function encodeSSE(env: EventEnvelope): string {
  return `id: ${env.seq}\nevent: ${env.event.type}\ndata: ${JSON.stringify(env)}\n\n`
}

/** A streaming `Response` of server-sent events. */
export function sseResponse(source: AsyncIterable<EventEnvelope>, init: ResponseInit & { keepAliveMs?: number } = {}): Response {
  let timer: ReturnType<typeof setInterval> | undefined
  const iterator = source[Symbol.asyncIterator]()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"))
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        } catch {
          clearInterval(timer)
        }
      }, init.keepAliveMs ?? 15_000)
    },
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) {
          clearInterval(timer)
          controller.close()
        } else controller.enqueue(encoder.encode(encodeSSE(value)))
      } catch (e) {
        clearInterval(timer)
        controller.error(e)
      }
    },
    async cancel() {
      clearInterval(timer)
      await iterator.return?.()
    },
  })
  const headers = new Headers(init.headers)
  headers.set("content-type", "text/event-stream; charset=utf-8")
  headers.set("cache-control", "no-cache, no-transform")
  headers.set("connection", "keep-alive")
  headers.set("x-accel-buffering", "no")
  return new Response(stream, { status: init.status ?? 200, headers })
}

/** Read server-sent events from a fetch body. Yields parsed envelopes. */
export async function* decodeSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<EventEnvelope> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const onAbort = () => reader.cancel().catch(() => {})
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const chunk = buf.slice(0, idx)
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "")
        const data = chunk
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n")
        if (data) yield JSON.parse(data) as EventEnvelope
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
    reader.releaseLock()
  }
}
