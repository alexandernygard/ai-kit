import { Worker } from "node:worker_threads"
import type { Sandbox } from "@alexandernygard/ai-kit"

const WORKER = String.raw`
const { parentPort, workerData } = require("node:worker_threads")
const vm = require("node:vm")
let seq = 0
const pending = new Map()
parentPort.on("message", (m) => {
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  if (m.error !== undefined) p.reject(new Error(m.error))
  else p.resolve(m.value)
})
const call = (name, input) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    parentPort.postMessage({ type: "call", id, name, input: input === undefined ? {} : JSON.parse(JSON.stringify(input)) })
  })
const fmt = (a) => { try { return typeof a === "string" ? a : JSON.stringify(a) } catch { return String(a) } }
const tools = new Proxy({}, { get: (_, name) => (typeof name === "string" && name !== "then" ? (input) => call(name, input) : undefined) })
const log = (level) => (...args) => parentPort.postMessage({ type: "log", level, text: args.map(fmt).join(" ") })
const context = vm.createContext({ tools, console: { log: log("log"), info: log("log"), warn: log("error"), error: log("error") } }, {
  codeGeneration: { strings: false, wasm: false },
})
;(async () => {
  try {
    const fn = vm.runInContext("(async (tools, console) => {\"use strict\";\n" + workerData.code + "\n})", context, { timeout: workerData.syncTimeoutMs })
    const value = await fn(context.tools, context.console)
    parentPort.postMessage({ type: "done", value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) })
  } catch (e) {
    parentPort.postMessage({ type: "done", error: e && e.name ? e.name + ": " + e.message : String(e) })
  }
})()
`

export interface WorkerSandboxOptions {
  /** Heap limit for the worker. Default 128 MB. */
  memoryMb?: number
  /** Limit for synchronous stretches (tight loops). Default 2 s. */
  syncTimeoutMs?: number
}

/**
 * Runs code-mode scripts in a worker thread with a fresh V8 context: no `require`, `process`,
 * filesystem or network, only `tools` and `console`. Killed on timeout or abort, with a heap
 * cap. This contains mistakes well; for hostile code use a stronger boundary (a container,
 * Firecracker, a Cloudflare Worker Loader) behind the same `Sandbox` interface.
 */
export function workerSandbox(options: WorkerSandboxOptions = {}): Sandbox {
  return {
    name: "worker",
    execute(code, env) {
      return new Promise((resolve) => {
        const worker = new Worker(WORKER, {
          eval: true,
          workerData: { code, syncTimeoutMs: options.syncTimeoutMs ?? 2000 },
          resourceLimits: { maxOldGenerationSizeMb: options.memoryMb ?? 128 },
          env: {},
          stdout: true,
          stderr: true,
        })
        let settled = false
        const finish = (r: { result?: unknown; error?: string }) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          env.signal.removeEventListener("abort", onAbort)
          void worker.terminate()
          resolve(r)
        }
        const timer = setTimeout(() => finish({ error: `Timed out after ${env.timeoutMs} ms` }), env.timeoutMs)
        const onAbort = () => finish({ error: "Aborted" })
        env.signal.addEventListener("abort", onAbort, { once: true })
        worker.on("message", async (m: { type: string; id?: number; name?: string; input?: unknown; level?: string; text?: string; value?: unknown; error?: string }) => {
          if (m.type === "log") (m.level === "error" ? env.console.error : env.console.log)(m.text)
          else if (m.type === "done") finish(m.error !== undefined ? { error: m.error } : { result: m.value })
          else if (m.type === "call") {
            const fn = env.tools[m.name!]
            try {
              if (!fn) throw new Error(`tools.${m.name} doesn't exist`)
              const value = await fn(m.input)
              if (!settled) worker.postMessage({ id: m.id, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) })
            } catch (e) {
              if (!settled) worker.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) })
            }
          }
        })
        worker.on("error", (e: Error) => finish({ error: `${e.name}: ${e.message}` }))
        worker.on("exit", (c) => finish({ error: `Sandbox exited (${c})` }))
      })
    },
  }
}
