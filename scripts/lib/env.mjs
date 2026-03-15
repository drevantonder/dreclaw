#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function loadDotEnvIntoProcess(filePath = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rest] = match;
    if (process.env[key] != null && process.env[key] !== "") continue;
    let value = rest;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
  return true;
}

export function getDefaultVpBin() {
  return process.env.VITE_PLUS_BIN || path.join(os.homedir(), ".vite-plus", "bin", "vp");
}
