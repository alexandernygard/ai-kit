import type { Kit } from "./kit"
import type { RunResult } from "./run"
import type { JSONSchema, Schema } from "./schema"
import type { SendOptions } from "./session"

/*
 * Workflow helpers for code-orchestrated multi-agent patterns (Anthropic's "Building effective
 * agents"): chains, parallel fan-out, routing and evaluator loops. Each step is a `kit.generate`
 * call, so it uses the agent's tools, skills and permissions.
 */

export interface StepOptions<Ctx = any> extends SendOptions<Ctx> {
  agent: string
}

/** Run agents one after another, each getting the previous answer. */
export async function chain<Ctx>(
  kit: Kit<Ctx>,
  input: string,
  steps: Array<StepOptions<Ctx> & { prompt?: (previous: string) => string }>,
): Promise<RunResult[]> {
  const results: RunResult[] = []
  let current = input
  for (const step of steps) {
    const r = await kit.generate(step.prompt ? step.prompt(current) : current, step)
    if (r.finishReason === "error") throw new Error(r.error?.message ?? "Step failed")
    results.push(r)
    current = r.output !== undefined ? JSON.stringify(r.output) : r.text
  }
  return results
}

/** Run tasks at once, at most `concurrency` at a time. */
export async function parallel<Ctx>(
  kit: Kit<Ctx>,
  tasks: Array<StepOptions<Ctx> & { prompt: string }>,
  options: { concurrency?: number } = {},
): Promise<RunResult[]> {
  const results: RunResult[] = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await kit.generate(tasks[i]!.prompt, tasks[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, tasks.length) }, worker))
  return results
}

/** Classify the input with `router`, then hand it to the chosen agent. */
export async function route<Ctx>(
  kit: Kit<Ctx>,
  input: string,
  options: { router: string; routes: Record<string, string>; context?: Ctx },
): Promise<RunResult & { route: string }> {
  const names = Object.keys(options.routes)
  const schema: JSONSchema = {
    type: "object",
    properties: { route: { type: "string", enum: names }, reason: { type: "string" } },
    required: ["route"],
  }
  const choice = await kit.generate(
    `Pick the best route for this request.\nRoutes:\n${names.map((n) => `- ${n}`).join("\n")}\n\nRequest:\n${input}`,
    { agent: options.router, output: schema, context: options.context },
  )
  const picked = (choice.output as { route?: string } | undefined)?.route
  const agent = (picked && options.routes[picked]) || options.routes[names[0]!]!
  const result = await kit.generate(input, { agent, context: options.context })
  return { ...result, route: picked ?? names[0]! }
}

/**
 * Generate, then let an evaluator grade and give feedback, until it passes or `maxRounds`.
 */
export async function evaluateLoop<Ctx>(
  kit: Kit<Ctx>,
  task: string,
  options: { generator: string; evaluator: string; maxRounds?: number; criteria?: string; context?: Ctx; output?: Schema | JSONSchema },
): Promise<{ result: RunResult; rounds: number; passed: boolean; feedback?: string }> {
  const verdictSchema: JSONSchema = {
    type: "object",
    properties: { pass: { type: "boolean" }, feedback: { type: "string" } },
    required: ["pass", "feedback"],
  }
  let prompt = task
  let feedback: string | undefined
  const max = options.maxRounds ?? 3
  for (let round = 1; ; round++) {
    const result = await kit.generate(prompt, { agent: options.generator, context: options.context, output: options.output })
    const answer = result.output !== undefined ? JSON.stringify(result.output, null, 2) : result.text
    const verdict = await kit.generate(
      `Task:\n${task}\n\n${options.criteria ? `Criteria:\n${options.criteria}\n\n` : ""}Answer to grade:\n${answer}`,
      { agent: options.evaluator, output: verdictSchema, context: options.context },
    )
    const v = verdict.output as { pass: boolean; feedback: string } | undefined
    feedback = v?.feedback
    if (v?.pass || round >= max) return { result, rounds: round, passed: !!v?.pass, feedback }
    prompt = `${task}\n\nYour previous answer:\n${answer}\n\nFeedback to address:\n${feedback}`
  }
}
