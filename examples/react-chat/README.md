# React chat example

A travel concierge built with ai-kit and `@alexandernygard/components`. It shows sessions in a sidebar, streaming, tool traces, approvals ("Book this flight?"), `ask_user` as a Questionnaire, a browser-side tool (geolocation), a deferred toolkit, a SKILL.md skill, a subagent, todos, version arrows, regenerate and fork.

```bash
pnpm build                                   # from the repo root, once
pnpm --filter example-react-chat dev         # API on :8787, app on :5173
```

Without `ANTHROPIC_API_KEY` the agent runs on your Claude subscription through Claude Code (log in with `claude` first). With the key set, it uses the Anthropic API through the AI SDK. Sessions are saved in `.ai-kit/`.

- [agent.ts](agent.ts): agent, tools, toolkit, plugin, command, subagent
- [server.ts](server.ts): kit, file store, HTTP handler with auth
- [src/App.tsx](src/App.tsx): the UI
