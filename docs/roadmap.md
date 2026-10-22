# Roadmap: a scalable ai-kit

Goal: one small, stable core that fits every shape of AI app (pure server, full-stack, browser-only with a user's own key, CLI), and that stays easy to maintain as the number of apps grows.

This plan comes from reviewing the AI code in xl2, ppt2 and word2. Each re-implements the same Claude tool loop by hand (400-500 lines each) and has needs ai-kit doesn't cover yet. See "Findings from xl2, ppt2 and word2" at the end.

## Principles

1. **Deployment shapes, not forks.** One agent definition runs on a server, in a browser, on an edge worker or in a CLI. Where the loop runs, who owns state and how the UI connects are choices, not different libraries.
2. **Four layers, each depending only on the one below.**
   1. Protocol: events, messages, parts. Typed and serializable.
   2. Runtime: runner, tools, sessions, stores, hooks. No UI, HTTP or provider code.
   3. Adapters: drivers, stores, transports, MCP. One package each, depending on core only.
   4. Experience: React/Svelte hooks, panels, quick starts. Thin and allowed to be opinionated.
3. **The protocol is the real API.** Most breaking changes come from event and message shapes changing.
4. **Extension points before features.** A new capability should be a plugin, hook, provider or adapter. If it can't be, fix the extension point instead of adding a core flag.
5. **The provider is isolated.** Claude-only is fine, but all API-specific fields live in `ai-kit-anthropic`, in one place.
6. **Easy by default, explicit when needed.** A new app should need very few lines; escape hatches stay reachable.
7. **Extract, don't invent.** Build a feature inside a real app first, then lift it into ai-kit once a second app needs it. Lock down shapes (versioning, API checks) only after real use has shown which ones are right.

## Phase 1: Trust (verify what exists)

Nothing has run against the real API yet. Do this before building more.

- [x] **Live-API smoke tests.** `pnpm test:live` (`packages/anthropic/test/live.test.ts`) covers streaming text, tool call round trip, abort, thinking, server compaction, fallbacks, usage and errors. The nightly job is `.github/workflows/live.yml`; it needs the `ANTHROPIC_API_KEY` secret and the `AI_KIT_LIVE_NIGHTLY` variable set to `true`.
- [x] **Driver contract suite.** `driverContract` in `@alexandernygard/ai-kit/testing`; the mock, Claude and AI SDK drivers pass it.
- [x] **Shape conformance test.** (`packages/client/test/conformance.test.ts`) Run one agent three ways (direct `kit`, `createHandler` + `Chat` over HTTP, `directTransport`) and assert identical events after normalizing ids and timestamps.
- [x] **Model capability table.** `CLAUDE_MODELS` in `packages/anthropic/src/models.ts`; a new model is a one-line change.

Done when: the live job and conformance test pass in CI. Still open: the live suite hasn't run yet (no API key on the dev machine), and the repo has no GitHub remote for the workflows.

## Phase 2: Split the runner

- [x] **Split `packages/core/src/runner.ts`** (1,223 lines, now `runner/*.ts`) by responsibility: step loop, tool execution, approvals, compaction. Keep the public API and use existing tests as the safety net. No behaviour change.

Done when: runner is split and all existing tests pass unchanged. Do this before Phase 3, which adds to the loop.

## Phase 3: Browser-only apps

What all three apps need first. Goes into the existing `client` and `react` packages, not a new one.

- [ ] **Browser entry point**: `createBrowserKit` with `dangerouslyAllowBrowser`, a bring-your-own-key and model/effort settings store, `useAssistant`, wired to `directTransport` and an IndexedDB store. Per-document sessions are a session-id convention (one session per document id), not a separate feature.
- [ ] **`sourceTools`**: `read`, `edit` (unique exact match), `write`, plus a feedback hook where the app returns a compile/evaluate/lint report to the model.
- [ ] **Partial tool input helper**: expose live partial input per tool call (from `tool-input-delta`) so UIs can preview a document as it streams.
- [ ] Confirm images in tool results work end to end through runner and driver (screenshots back to the model).
- [ ] **Starter**: a browser-only example built and tested in CI, next to `node-cli`.

Done when: a browser-only app needs only its own tool bodies, system prompt and one feedback function.

## Phase 4: Pilot (xl2)

- [ ] Move xl2's assistant onto ai-kit. Let what hurts set the next release.
- [ ] **Prototype edit proposals inside xl2**: a tool returns a patch and a label; the host applies it live; the user accepts or rejects; outcomes flow back to the model as context next turn. Settle the hard case here: the model edits on top of a pending change, then the user rejects the change underneath.
- [ ] Prototype change-aware context in xl2: a context provider that reports "unchanged since last turn" via a hash.

Done when: xl2's hand-written loop is deleted. Measure it in lines removed.

## Phase 5: Extract and port

- [ ] **Edit proposals** (`ai-kit-edits`): lift the xl2 prototype into a package when ppt2 needs it.
- [ ] **Change-aware context**: lift into core as a context provider option.
- [ ] Port ppt2 and word2; remove their hand-written loops.
- [ ] Quick-actions helper for prompts like "tighten" or "summarize", if two apps end up with the same one.

Done when: no app has its own tool loop.

## Phase 6: Lock it down

Only now are the shapes proven by three apps.

- [ ] Write `docs/protocol.md`: events, messages, parts, session and run lifecycle. Treat it as the contract.
- [ ] Make stored messages forward-compatible: unknown part types pass through, never crash.
- [ ] Golden-file tests: recorded event streams replayed through the reducer; a snapshot fails if the UI-visible result changes.
- [ ] **Dependency-direction check in CI** so lower layers can't import higher ones.
- [ ] **Public API surface check** (export snapshot or `api-extractor`) so accidental breaking changes fail CI.
- [ ] Deprecation policy: keep old names for one release with a warning and a migration note in the changeset.
- [ ] **Sensible defaults**: `createKit({ agents })` works with a memory store and an env-var key.
- [ ] **Evals runner** over `kit.generate` + `evaluateLoop`, using `mockModel` for determinism and the real API opt-in, so prompt, model and library changes can be measured.
- [ ] **Shared skills**: SDK references as SKILL.md folders loaded on demand instead of big prompts.

## Later, when an app needs it

- `protocolVersion` in the stream handshake. Browser-only apps ship the loop and UI in one bundle, so they can't drift apart; this matters once a separately deployed server has older clients.
- `server-only` and `fullstack-react` starters.
- Plugins for per-user budgets and rate limits, OpenTelemetry tracing, redaction and guardrails as hooks.
- Cross-app agents through Drive, subagents (visual critic, copy editor), optional server mode that keeps the key off the client.

## Order of work

1. Live smoke test, contract suite, capability table and conformance test (Phase 1)
2. Split `runner.ts` (Phase 2)
3. Browser entry point, `sourceTools` and partial tool input (Phase 3)
4. Port xl2, prototyping edit proposals and change-aware context there (Phase 4)
5. Extract edits and change-aware context, port ppt2 and word2 (Phase 5)
6. Protocol doc, golden tests, CI checks and evals (Phase 6)

## Open still, from earlier work

Programmatic tool calling to replace code mode, `count_tokens` and the Models API for context size, `thinking.display: "updates"`, on-demand compaction, durable runs, and Batches/Files wrappers. See `docs/feature-map.md`.

## Findings from xl2, ppt2 and word2

All three are browser-only editors for "document as code" with a Claude panel (key in localStorage). Each hand-writes:

- the streaming tool loop and its edge cases (`refusal`, `pause_turn`, `max_tokens`, abort leaving an unanswered `tool_use`)
- the same request params (adaptive thinking, effort, cache, fallbacks, eager input streaming)
- chat state and a panel (zustand store, messages, parts, abort, per-file transcripts)
- bring-your-own-key and model settings
- `<source>`, `<selection>`, `<error>` context blocks each turn
- live preview of partial tool input while a file is written
- near-identical edit tools (exact-string edit, write whole file, read)
- a self-check after each edit (evaluate, lint, inspect) fed back to the model

Needs ai-kit lacks today: running in the browser with the user's own key, reviewable edits (apply live, accept or reject later, tell the model what was rejected), live partial tool input, and change-aware context.
