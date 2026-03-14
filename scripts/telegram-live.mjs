#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 800;
const AUTH_STATE_PATH = path.join(process.cwd(), ".telegram-test-auth.json");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
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
}

function parseArgs(argv) {
  const args = {
    prompt: "",
    bot: process.env.TELEGRAM_TEST_BOT_USERNAME ?? process.env.TELEGRAM_BOT_USERNAME ?? "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    expect: [],
    reject: [],
    json: false,
    loginOnly: false,
    phone: process.env.TELEGRAM_TEST_PHONE ?? "",
    code: process.env.TELEGRAM_TEST_CODE ?? "",
    password: process.env.TELEGRAM_TEST_PASSWORD ?? "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--prompt") args.prompt = argv[++i] ?? "";
    else if (part === "--bot") args.bot = argv[++i] ?? args.bot;
    else if (part === "--timeout-ms") args.timeoutMs = Number(argv[++i] ?? args.timeoutMs);
    else if (part === "--poll-ms") args.pollMs = Number(argv[++i] ?? args.pollMs);
    else if (part === "--expect") args.expect.push(argv[++i] ?? "");
    else if (part === "--reject") args.reject.push(argv[++i] ?? "");
    else if (part === "--json") args.json = true;
    else if (part === "--login") args.loginOnly = true;
    else if (part === "--phone") args.phone = argv[++i] ?? "";
    else if (part === "--code") args.code = argv[++i] ?? "";
    else if (part === "--password") args.password = argv[++i] ?? "";
    else if (part === "--help" || part === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(args.pollMs) || args.pollMs <= 0) args.pollMs = DEFAULT_POLL_MS;

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: vp run live:telegram -- --prompt "hello"',
      "",
      "Options:",
      "  --prompt <text>",
      "  --bot <username>",
      "  --timeout-ms <n>",
      "  --poll-ms <n>",
      "  --expect <text>   Can repeat",
      "  --reject <text>   Can repeat",
      "  --json",
      "  --login           Login/update session only",
      "  --phone <number>",
      "  --code <login-code>",
      "  --password <2fa-password>",
      "",
      "Env:",
      "  TELEGRAM_TEST_API_ID",
      "  TELEGRAM_TEST_API_HASH",
      "  TELEGRAM_TEST_SESSION",
      "  TELEGRAM_TEST_BOT_USERNAME",
      "  TELEGRAM_TEST_PHONE",
      "  TELEGRAM_TEST_CODE",
      "  TELEGRAM_TEST_PASSWORD",
    ].join("\n") + "\n",
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "");
}

function readAuthState() {
  if (!fs.existsSync(AUTH_STATE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(AUTH_STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeAuthState(value) {
  fs.writeFileSync(AUTH_STATE_PATH, `${JSON.stringify(value, null, 2)}\n`);
}

function clearAuthState() {
  if (fs.existsSync(AUTH_STATE_PATH)) fs.unlinkSync(AUTH_STATE_PATH);
}

function getRequiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) fail(`Missing ${name}`);
  return value;
}

function getMessageText(message) {
  const value = message?.message ?? message?.text ?? "";
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMessage(message) {
  const id = Number(message?.id ?? 0);
  const direction = message?.out ? "me" : "bot";
  const text = getMessageText(message);
  return { id, direction, text };
}

function pickReply(messages, minId) {
  return messages
    .map(formatMessage)
    .filter((message) => message.id > minId)
    .sort((a, b) => a.id - b.id);
}

function assertTranscript(transcript, expect, reject) {
  const joined = transcript.map((item) => item.text).join("\n");
  for (const needle of expect) {
    if (needle && !joined.includes(needle)) {
      throw new Error(`Expected reply to include: ${needle}`);
    }
  }
  for (const needle of reject) {
    if (needle && joined.includes(needle)) {
      throw new Error(`Reply included rejected text: ${needle}`);
    }
  }
}

async function connectClient(args) {
  const apiId = Number(getRequiredEnv("TELEGRAM_TEST_API_ID"));
  const apiHash = getRequiredEnv("TELEGRAM_TEST_API_HASH");
  const apiCredentials = { apiId, apiHash };
  const pending = readAuthState();
  if (!Number.isFinite(apiId) || apiId <= 0) fail("TELEGRAM_TEST_API_ID must be a positive number");

  const sessionValue = String(process.env.TELEGRAM_TEST_SESSION ?? pending?.pendingSession ?? "");
  const stringSession = new StringSession(sessionValue);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: false,
    baseLogger: new Logger(LogLevel.NONE),
  });

  await client.connect();
  if (!(await client.isUserAuthorized())) {
    const phone = String(args.phone ?? "").trim();
    const code = String(args.code ?? "").trim();
    const password = String(args.password ?? "").trim();
    if (!code) {
      if (!phone) fail("Missing Telegram phone number. Pass --phone or set TELEGRAM_TEST_PHONE");
      const sent = await client.sendCode(apiCredentials, phone);
      writeAuthState({
        phone,
        phoneCodeHash: sent.phoneCodeHash,
        dcId: client.session.dcId,
        pendingSession: client.session.save(),
        sentAt: new Date().toISOString(),
      });
      process.stdout.write(`Telegram login code sent to ${phone}. Re-run with --code <digits>.\n`);
      return client;
    }
    if (!pending?.phone || !pending?.phoneCodeHash) {
      fail("No pending Telegram auth state. Run --login without --code first to send a code.");
    }
    if (
      Number.isFinite(Number(pending.dcId)) &&
      Number(pending.dcId) > 0 &&
      client.session.dcId !== Number(pending.dcId)
    ) {
      await client._switchDC(Number(pending.dcId));
    }
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: String(pending.phone),
          phoneCodeHash: String(pending.phoneCodeHash),
          phoneCode: code,
        }),
      );
    } catch (error) {
      if (
        (error &&
          typeof error === "object" &&
          "errorMessage" in error &&
          error.errorMessage === "SESSION_PASSWORD_NEEDED") ||
        String(error).includes("SESSION_PASSWORD_NEEDED")
      ) {
        if (!password)
          fail(
            "Telegram 2FA password required. Re-run with --password or set TELEGRAM_TEST_PASSWORD.",
          );
        await client.signInWithPassword(apiCredentials, {
          password: async () => password,
          onError: (err) => {
            throw err;
          },
        });
      } else {
        throw error;
      }
    }
    clearAuthState();
    const saved = String(client.session.save());
    process.stdout.write(`Save this in .env as TELEGRAM_TEST_SESSION:\n${saved}\n`);
  }

  return client;
}

async function runPrompt(client, args) {
  const bot = normalizeUsername(args.bot);
  if (!bot) fail("Missing bot username. Set TELEGRAM_TEST_BOT_USERNAME or pass --bot");
  if (!args.prompt.trim()) fail("Missing prompt. Pass --prompt or --scenario");

  const entity = await client.getEntity(bot);
  const beforeMessages = await client.getMessages(entity, { limit: 10 });
  const baselineId = beforeMessages.reduce(
    (max, message) => Math.max(max, Number(message?.id ?? 0)),
    0,
  );

  await client.sendMessage(entity, { message: args.prompt });

  const deadline = Date.now() + args.timeoutMs;
  let transcript = [];
  let lastNonThinkingAt = 0;

  while (Date.now() < deadline) {
    const messages = await client.getMessages(entity, { limit: 20 });
    transcript = pickReply(messages, baselineId);

    const botReplies = transcript.filter((message) => message.direction === "bot");
    const nonThinkingReplies = botReplies.filter(
      (message) => message.text && message.text !== "Thinking...",
    );

    if (nonThinkingReplies.length) {
      if (!lastNonThinkingAt) lastNonThinkingAt = Date.now();
      const latest = nonThinkingReplies[nonThinkingReplies.length - 1];
      const hasThinkingAfterLatest = botReplies.some(
        (message) => message.id > latest.id && message.text === "Thinking...",
      );
      if (!hasThinkingAfterLatest && Date.now() - lastNonThinkingAt >= 1200) {
        assertTranscript(botReplies, args.expect, args.reject);
        return { ok: true, bot, prompt: args.prompt, transcript };
      }
    }

    await sleep(args.pollMs);
  }

  throw new Error(`Timed out after ${args.timeoutMs}ms waiting for bot reply`);
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Bot: @${result.bot}\n`);
  process.stdout.write(`Prompt: ${result.prompt}\n`);
  process.stdout.write("Transcript:\n");
  for (const item of result.transcript) {
    process.stdout.write(`- ${item.direction}#${item.id}: ${item.text}\n`);
  }
}

async function main() {
  loadDotEnv(path.join(process.cwd(), ".env"));
  const args = parseArgs(process.argv.slice(2));
  const client = await connectClient(args);
  try {
    if (args.loginOnly) {
      if (await client.isUserAuthorized()) process.stdout.write("Telegram test session ready.\n");
      return;
    }
    const result = await runPrompt(client, args);
    printResult(result, args.json);
  } finally {
    await client.destroy();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unexpected Telegram live test failure");
});
