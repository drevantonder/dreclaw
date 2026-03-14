import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  assetsInclude: ["**/*.wasm"],
  resolve: {
    alias: {
      "cloudflare:workers": "/Users/drevan/projects/dreclaw/tests/support/cloudflare-workers.ts",
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: [".worktrees/**", "node_modules/**"],
  },
});
