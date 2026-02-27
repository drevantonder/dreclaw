#!/usr/bin/env node

const secretKeys = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_ALLOWED_USER_ID",
  "AI_PROVIDER",
  "OPENCODE_ZEN_API_KEY",
  "MODEL",
  "BASE_URL",
];

const payload = {};
for (const key of secretKeys) {
  const value = process.env[key];
  if (typeof value === "string" && value.length > 0) {
    payload[key] = value;
  }
}

if (Object.keys(payload).length === 0) {
  process.stderr.write("No env vars loaded. Run: set -a; source .env; set +a\n");
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(payload)}\n`);
