import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  resolve: {
    alias: {
      "cloudflare:workers": "/Users/drevan/projects/dreclaw/tests/support/cloudflare-workers.ts",
    },
  },
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: [".worktrees/**", "node_modules/**"],
  },
});
