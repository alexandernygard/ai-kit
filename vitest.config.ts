import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { conditions: ["ai-kit-source"] },
  ssr: { resolve: { conditions: ["ai-kit-source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx"],
  },
})
