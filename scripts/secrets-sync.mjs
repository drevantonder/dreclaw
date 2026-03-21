#!/usr/bin/env node
import { loadDotEnvIntoProcess } from "./lib/env.mjs";

loadDotEnvIntoProcess();

const secretKeys = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_ALLOWED_USER_ID",
  "AI_PROVIDER",
  "OPENCODE_API_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
  "GOOGLE_OAUTH_SCOPES",
  "GOOGLE_OAUTH_ENCRYPTION_KEY",
  "MODEL",
  "BASE_URL",
  "LIVE_TEST_SCENARIO_SECRET",
];

const payload = {};
for (const key of secretKeys) {
  const value = process.env[key];
  if (typeof value === "string" && value.length > 0) {
    payload[key] = value;
  }
}

if (Object.keys(payload).length === 0) {
  process.stderr.write("No env vars loaded from process or .env\n");
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(payload)}\n`);
