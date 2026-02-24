#!/usr/bin/env node
import { accessSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    bucket: "",
    local: false,
    config: "",
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--bucket") args.bucket = argv[++i] ?? args.bucket;
    else if (part === "--config") args.config = argv[++i] ?? args.config;
    else if (part === "--local") args.local = true;
    else if (part === "--force") args.force = true;
    else if (part === "--help" || part === "-h") {
      process.stdout.write(
        "Usage: pnpm seed:memory [-- --bucket <r2-bucket>] [--config wrangler.toml] [--local] [--force]\n",
      );
      process.exit(0);
    }
  }

  return args;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function detectBucket(configPath) {
  try {
    const content = readFileSync(configPath, "utf8");
    const match = /\[\[r2_buckets\]\][\s\S]*?bucket_name\s*=\s*"([^"]+)"/.exec(content);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function runWranglerPut({ bucket, key, filePath, local, config }) {
  const args = ["dlx", "wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", filePath, "--content-type", "text/markdown; charset=utf-8"];
  args.push(local ? "--local" : "--remote");
  if (config) args.push("--config", config);

  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  if (result.status !== 0) {
    fail(`Failed: ${bucket}/${key}`);
  }
}

function objectExists({ bucket, key, local, config }) {
  const args = ["dlx", "wrangler", "r2", "object", "get", `${bucket}/${key}`, "--pipe"];
  args.push(local ? "--local" : "--remote");
  if (config) args.push("--config", config);
  const result = spawnSync("pnpm", args, { stdio: "ignore" });
  return result.status === 0;
}

function ensureObject({ bucket, key, filePath, local, config, force }) {
  if (!force && objectExists({ bucket, key, local, config })) {
    process.stdout.write(`Skip existing: ${bucket}/${key}\n`);
    return;
  }
  runWranglerPut({ bucket, key, filePath, local, config });
  process.stdout.write(`Seeded: ${bucket}/${key}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(process.cwd(), args.config || "wrangler.toml");
  const bucket = args.bucket || detectBucket(configPath);
  if (!bucket) {
    fail("Missing R2 bucket. Pass --bucket <name> or define [[r2_buckets]] bucket_name in wrangler.toml.");
  }

  const initialFilesystemPath = resolve(process.cwd(), "src", "initial-filesystem");
  const soulPath = resolve(initialFilesystemPath, "SOUL.md");
  const memoryPath = resolve(initialFilesystemPath, "MEMORY.md");
  try {
    accessSync(soulPath);
    accessSync(memoryPath);
  } catch {
    fail("SOUL.md or MEMORY.md not found under src/initial-filesystem.");
  }

  ensureObject({ bucket, key: "defaults/SOUL.md", filePath: soulPath, local: args.local, config: args.config, force: args.force });
  ensureObject({ bucket, key: "defaults/MEMORY.md", filePath: memoryPath, local: args.local, config: args.config, force: args.force });

  process.stdout.write("Default memory seeds ready. New sessions will use them if session files are missing.\n");
}

main();
