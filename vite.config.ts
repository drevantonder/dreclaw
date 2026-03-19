import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  resolve: {
    alias: {
      "cloudflare:workers": "/Users/drevan/projects/dreclaw/test/support/cloudflare-workers.ts",
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.ts"],
    exclude: [".worktrees/**", "node_modules/**"],
  },
});
