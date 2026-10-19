import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { type Skill, skillFromMarkdown } from "@alexandernygard/ai-kit"

/**
 * Load Agent Skills from a folder: every subfolder with a SKILL.md becomes a skill, and its
 * other files become readable resources (loaded only when the agent asks).
 *
 * ```
 * skills/
 *   refunds/SKILL.md
 *   refunds/policy.md
 *   pdf/SKILL.md
 *   pdf/scripts/fill.py
 * ```
 */
export async function loadSkills(dir: string, options: { maxFileBytes?: number } = {}): Promise<Skill[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const skills: Skill[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const root = join(dir, e.name)
    const md = await readFile(join(root, "SKILL.md"), "utf8").catch(() => null)
    if (md === null) continue
    const files: Record<string, () => Promise<string>> = {}
    for (const f of await walk(root)) {
      const rel = relative(root, f).split(sep).join("/")
      if (rel === "SKILL.md") continue
      files[rel] = async () => {
        const size = (await stat(f)).size
        if (size > (options.maxFileBytes ?? 200_000)) return `(${rel} is ${size} bytes, too large to read whole)`
        return readFile(f, "utf8")
      }
    }
    skills.push(skillFromMarkdown(md, { files, metadata: { path: root } }))
  }
  return skills
}

/** Load one skill folder. */
export async function loadSkill(dir: string): Promise<Skill> {
  const md = await readFile(join(dir, "SKILL.md"), "utf8")
  const files: Record<string, () => Promise<string>> = {}
  for (const f of await walk(dir)) {
    const rel = relative(dir, f).split(sep).join("/")
    if (rel !== "SKILL.md") files[rel] = () => readFile(f, "utf8")
  }
  return skillFromMarkdown(md, { files, metadata: { path: dir } })
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}
