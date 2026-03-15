#!/usr/bin/env node
import { spawn } from "node:child_process";

const vpBin = process.env.VITE_PLUS_BIN || "/Users/drevan/.vite-plus/bin/vp";

const child = spawn(vpBin, ["dlx", "wrangler", ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
