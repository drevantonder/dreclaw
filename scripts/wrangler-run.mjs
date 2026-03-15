#!/usr/bin/env node
import { spawn } from "node:child_process";
import { getDefaultVpBin, loadDotEnvIntoProcess } from "./lib/env.mjs";

loadDotEnvIntoProcess();

const vpBin = getDefaultVpBin();

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
