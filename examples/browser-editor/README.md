# Browser editor

A browser-only document editor with a Claude assistant. No server: the agent loop runs in the
page with the user's own API key, and each document keeps its own conversation in IndexedDB.

```bash
pnpm --filter example-browser-editor dev
```

Paste an Anthropic API key in the panel, then ask for a change ("add a member named Grace").

What each part does:

- `src/assistant.ts`: the whole ai-kit setup.
  - `settingsStore` keeps the key, model and effort in localStorage.
  - `claudeFromSettings` reads them on every call.
  - `sourceTools` gives the model `read_file`, `edit_file` and `write_file` over the open document, with a `feedback` check that tells it whether the JSON is still valid.
  - A context provider attaches the current document to each turn.
  - `createBrowserKit` stores sessions in IndexedDB.
- `src/App.tsx`: the UI. `useAssistant` opens the conversation for the selected document; `toolInput` previews a `write_file` while it streams.
- `src/documents.ts`: the app's own documents, in localStorage. Nothing ai-kit specific.
