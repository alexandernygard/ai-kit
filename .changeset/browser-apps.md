---
"@alexandernygard/ai-kit": minor
"@alexandernygard/ai-kit-anthropic": minor
"@alexandernygard/ai-kit-client": minor
"@alexandernygard/ai-kit-react": minor
---

Browser-only apps. `createBrowserKit` runs a kit in the page with sessions in IndexedDB (`indexedDBKV`) and a `directTransport`; `settingsStore` keeps the user's key, model and effort in localStorage, and `claudeFromSettings` reads them on every call. `useAssistant` keeps one conversation per document (`findDocumentSession`), and `useSettings` binds a settings store. `sourceTools` adds `read_file`, `edit_file` (unique exact match) and `write_file` with a `feedback` hook for compile or lint reports; `memoryFiles` backs them in memory. `toolInput(part)` and `parsePartialJson` give a tool call's input while it streams.
