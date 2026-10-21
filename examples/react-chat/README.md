# React chat example

A travel concierge built with ai-kit and `@alexandernygard/components`. It shows sessions in a sidebar, streaming, tool traces, approvals ("Book this flight?"), `ask_user` as a Questionnaire, a browser-side tool (geolocation), a deferred toolkit, a SKILL.md skill, a subagent, todos, version arrows, regenerate and fork.

```bash
pnpm build                                   # from the repo root, once
pnpm --filter example-react-chat dev         # API on :8787, app on :5173
```

The agent calls the Claude API through `@alexandernygard/ai-kit-anthropic`. Set `ANTHROPIC_API_KEY`, or log in once with `ant auth login`. Sessions are saved in `.ai-kit/`.

- [agent.ts](agent.ts): agent, tools, toolkit, plugin, command, subagent
- [server.ts](server.ts): kit, file store, HTTP handler with auth
- [src/App.tsx](src/App.tsx): the UI
