import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type KV, kvStore, type Store } from "@alexandernygard/ai-kit"

/** A KV on the filesystem: one JSON file per key, written atomically. */
export function fileKV(dir: string): KV {
  let ready: Promise<unknown> | undefined
  const ensure = () => (ready ??= mkdir(dir, { recursive: true }))
  const file = (key: string) => join(dir, `${encodeURIComponent(key)}.json`)
  return {
    async get(key) {
      try {
        return await readFile(file(key), "utf8")
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
        throw e
      }
    },
    async set(key, value) {
      await ensure()
      const tmp = `${file(key)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, value)
      await rename(tmp, file(key))
    },
    async delete(key) {
      await rm(file(key), { force: true })
    },
    async list(prefix) {
      await ensure()
      return (await readdir(dir))
        .filter((f) => f.endsWith(".json"))
        .map((f) => decodeURIComponent(f.slice(0, -5)))
        .filter((k) => k.startsWith(prefix))
    },
  }
}

/** Sessions on disk. Good for local apps, CLIs and single-server deployments. */
export function fileStore(dir = ".ai-kit"): Store {
  return kvStore(fileKV(dir))
}
