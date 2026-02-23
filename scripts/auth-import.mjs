#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  if (typeof parsed.provider === "string") {
    const single = normalizeCredential(parsed);
    if (!single) fail("Credential payload missing access token");
    return { [parsed.provider]: single };
  }

  const output = {};
  for (const [provider, value] of Object.entries(parsed)) {
    const normalized = normalizeCredential(value);
    if (normalized) {
      output[provider] = normalized;
    }
  }

  if (Object.keys(output).length === 0) {
    fail("No valid credentials found in payload");
  }

  return output;
}

function normalizeCredential(raw) {
  if (!raw || typeof raw !== "object") return null;

  const value = raw;
  const access = String(value.access ?? value.accessToken ?? "").trim();
  if (!access) return null;

  const refresh = String(value.refresh ?? value.refreshToken ?? "").trim();
  let expires = Number(value.expires ?? 0);
  if (!Number.isFinite(expires) || expires <= 0) {
    const expiresAt = toOptionalString(value.expiresAt);
    expires = expiresAt ? Date.parse(expiresAt) : Date.now() + 3600_000;
  }

  return { ...value, access, refresh, expires };
}

function toOptionalString(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
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
const tempFile = join(tmpdir(), `dreclaw-auth-import-${Date.now()}.json`);
writeFileSync(tempFile, value);

const run = spawnSync(
  "pnpm",
  ["dlx", "wrangler", "kv", "key", "put", "provider-auth-map", "--binding", "AUTH_KV", "--path", tempFile, "--remote"],
  { stdio: "inherit" },
);

unlinkSync(tempFile);

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}
