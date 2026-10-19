import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"

/**
 * Serve a fetch-style handler (the ai-kit server, an MCP handler) from node:http or Express.
 *
 * ```ts
 * http.createServer(toNodeHandler(createHandler(kit))).listen(3000)
 * app.use("/api/ai", toNodeHandler(handler)) // Express: mount without stripping the path
 * ```
 */
export function toNodeHandler(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController()
    res.on("close", () => controller.abort())
    try {
      const host = req.headers.host ?? "localhost"
      const url = new URL((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? "/", `http://${host}`)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
        else if (v !== undefined) headers.set(k, v)
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD"
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        signal: controller.signal,
        // @ts-expect-error Node needs this for streamed request bodies
        duplex: hasBody ? "half" : undefined,
      })
      const response = await handler(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (!response.body) return res.end()
      const reader = response.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        res.write(value)
      }
      res.end()
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  }
}
