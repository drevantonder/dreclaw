#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { file: "", json: "", base64: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--file") args.file = argv[++i] ?? "";
    else if (part === "--json") args.json = argv[++i] ?? "";
    else if (part === "--base64") args.base64 = argv[++i] ?? "";
    else if (part === "--help" || part === "-h") {
      process.stdout.write("Usage: pnpm auth:import -- --file <path>|--json '<json>'|--base64 <encoded>\n");
      process.exit(0);
    }
  }
  return args;
}

function normalizePayload(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    fail("Invalid JSON payload");
  }

  if (!parsed || typeof parsed !== "object") fail("Payload must be a JSON object");

  if (typeof parsed.provider === "string" && typeof parsed.accessToken === "string") {
    return { [parsed.provider]: parsed };
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
let source = args.json;

if (args.file) {
  source = readFileSync(args.file, "utf8");
}

if (args.base64) {
  source = Buffer.from(args.base64, "base64url").toString("utf8");
}

if (!source) {
  fail("Missing input. Use --file, --json, or --base64");
}

const map = normalizePayload(source);
const value = JSON.stringify(map);
const run = spawnSync("pnpm", ["dlx", "wrangler", "kv", "key", "put", "--binding", "AUTH_KV", "provider-auth-map", value], {
  stdio: "inherit",
});

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}
