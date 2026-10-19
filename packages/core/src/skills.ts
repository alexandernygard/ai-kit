import { jsonSchema } from "./schema"
import { type Tool, type Toolkit, tool } from "./tools"

/**
 * A skill: instructions plus optional files and tools that the agent loads only when a task
 * calls for it. Only the name and description sit in the system prompt, so an agent can have
 * dozens of skills at little context cost. Compatible with the Agent Skills format
 * (a folder with SKILL.md and resources), which the node package loads from disk.
 */
export interface Skill {
  readonly kind: "skill"
  name: string
  /** When to use it. The agent reads this to decide, so be specific. */
  description: string
  /** The SKILL.md body. A function loads it on demand. */
  instructions: string | (() => Promise<string>)
  /** Extra files the agent can read: references, templates, scripts. Values load lazily. */
  files?: Record<string, string | (() => Promise<string>)>
  /** Tools that become available once the skill is loaded. */
  tools?: Array<Tool | Toolkit>
  /** Tools this skill expects; listed for the model, not enforced. */
  allowedTools?: string[]
  metadata?: Record<string, unknown>
}

export function defineSkill(def: Omit<Skill, "kind">): Skill {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(def.name)) {
    throw new Error(`Skill name "${def.name}" must be lowercase letters, digits and hyphens.`)
  }
  return { ...def, kind: "skill" }
}

export function isSkill(x: unknown): x is Skill {
  return typeof x === "object" && x !== null && (x as Skill).kind === "skill"
}

/** Split a SKILL.md into its YAML frontmatter (flat keys and simple lists) and body. */
export function parseSkillMarkdown(md: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md)
  if (!m) return { frontmatter: {}, body: md }
  const frontmatter: Record<string, unknown> = {}
  let listKey: string | null = null
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && listKey) {
      ;(frontmatter[listKey] as unknown[]).push(unquote(item[1]!))
      continue
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, raw] = kv
    if (raw === "") {
      frontmatter[key!] = []
      listKey = key!
    } else {
      listKey = null
      const v = raw!.trim()
      frontmatter[key!] = v.startsWith("[") && v.endsWith("]")
        ? v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean)
        : unquote(v)
    }
  }
  return { frontmatter, body: m[2]!.trim() }
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, "$2")
}

/** Build a skill from SKILL.md text. */
export function skillFromMarkdown(md: string, extra: Partial<Omit<Skill, "kind">> = {}): Skill {
  const { frontmatter, body } = parseSkillMarkdown(md)
  const name = String(extra.name ?? frontmatter.name ?? "")
  const description = String(extra.description ?? frontmatter.description ?? "")
  if (!name || !description) throw new Error("SKILL.md needs a name and a description in its frontmatter.")
  const allowed = frontmatter["allowed-tools"]
  return defineSkill({
    name,
    description,
    instructions: body,
    allowedTools: Array.isArray(allowed) ? allowed.map(String) : typeof allowed === "string" ? allowed.split(/[,\s]+/).filter(Boolean) : undefined,
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
  })
}

export const LOADED_SKILLS_KEY = "ai-kit.loadedSkills"

/** The system prompt section that lists skills. */
export function skillsPrompt(skills: Skill[]): string {
  if (!skills.length) return ""
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return [
    "# Skills",
    "Skills hold instructions for specific tasks. When a task matches a skill's description, load it with the `load_skill` tool before starting, then follow it.",
    ...lines,
  ].join("\n")
}

/** `load_skill` and `read_skill_file`. Loading a skill also activates its tools. */
export function skillTools(skills: Skill[], onLoad: (skill: Skill) => void): Tool[] {
  const byName = new Map(skills.map((s) => [s.name, s]))
  const names = skills.map((s) => s.name)
  const load = tool({
    name: "load_skill",
    description: "Load a skill's full instructions. Use it when the task matches a skill listed in the system prompt.",
    input: jsonSchema<{ name: string }>({
      type: "object",
      properties: { name: { type: "string", enum: names, description: "Skill name" } },
      required: ["name"],
    }),
    readOnly: true,
    codeMode: false,
    title: (i) => `Loading skill ${i.name}`,
    async execute({ name }) {
      const skill = byName.get(name)
      if (!skill) return `No skill named ${name}. Available: ${names.join(", ")}`
      onLoad(skill)
      const body = typeof skill.instructions === "function" ? await skill.instructions() : skill.instructions
      const files = Object.keys(skill.files ?? {})
      const tools = (skill.tools ?? []).flatMap((t) => (t.kind === "toolkit" ? t.tools : [t])).map((t) => t.name)
      return [
        `# Skill: ${skill.name}`,
        body,
        files.length ? `\nFiles (read with read_skill_file):\n${files.map((f) => `- ${f}`).join("\n")}` : "",
        tools.length ? `\nTools now available: ${tools.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    },
  })
  const hasFiles = skills.some((s) => s.files && Object.keys(s.files).length)
  if (!hasFiles) return [load]
  const read = tool({
    name: "read_skill_file",
    description: "Read a file that belongs to a loaded skill.",
    input: jsonSchema<{ skill: string; path: string }>({
      type: "object",
      properties: { skill: { type: "string", enum: names }, path: { type: "string" } },
      required: ["skill", "path"],
    }),
    readOnly: true,
    codeMode: false,
    title: (i) => `Reading ${i.skill}/${i.path}`,
    async execute({ skill, path }) {
      const file = byName.get(skill)?.files?.[path]
      if (file === undefined) {
        const avail = Object.keys(byName.get(skill)?.files ?? {})
        return `No file ${path} in ${skill}. Files: ${avail.join(", ") || "none"}`
      }
      return typeof file === "function" ? await file() : file
    },
  })
  return [load, read]
}
