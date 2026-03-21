#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { TelegramClient } from "telegram";
import { Api } from "telegram";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { loadDotEnvIntoProcess } from "./lib/env.mjs";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_MS = 800;
const DEFAULT_QUIET_MS = 1200;
const TRACE_QUIET_MS = 4000;
const DEFAULT_SCENARIO_DURATION_MS = 65000;
const DEFAULT_SCENARIO_STEP_MS = 5000;
const DEFAULT_SCENARIO_SECOND_DELAY_MS = 1200;
const DEFAULT_SCENARIO_SECOND_DURATION_MS = 5000;
const AUTH_STATE_PATH = path.join(process.cwd(), ".telegram-test-auth.json");
const LIVE_LOCK_PATH = path.join(process.cwd(), ".telegram-live.lock");

function parseArgs(argv) {
  const args = {
    prompt: "",
    bot: process.env.TELEGRAM_TEST_BOT_USERNAME ?? process.env.TELEGRAM_BOT_USERNAME ?? "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    expect: [],
    reject: [],
    finalOnly: false,
    json: false,
    loginOnly: false,
    withModel: "",
    restorePreviousModel: false,
    withVerbose: "",
    restorePreviousVerbose: false,
    scenario: "",
    scenarioSecret: process.env.LIVE_TEST_SCENARIO_SECRET ?? "",
    scenarioDurationMs: DEFAULT_SCENARIO_DURATION_MS,
    scenarioStepMs: DEFAULT_SCENARIO_STEP_MS,
    scenarioSecondDelayMs: DEFAULT_SCENARIO_SECOND_DELAY_MS,
    scenarioSecondDurationMs: DEFAULT_SCENARIO_SECOND_DURATION_MS,
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
    else if (part === "--final-only") args.finalOnly = true;
    else if (part === "--json") args.json = true;
    else if (part === "--login") args.loginOnly = true;
    else if (part === "--with-model") args.withModel = argv[++i] ?? "";
    else if (part === "--restore-previous-model") args.restorePreviousModel = true;
    else if (part === "--with-verbose") args.withVerbose = argv[++i] ?? "";
    else if (part === "--restore-previous-verbose") args.restorePreviousVerbose = true;
    else if (part === "--scenario") args.scenario = argv[++i] ?? "";
    else if (part === "--scenario-secret") args.scenarioSecret = argv[++i] ?? "";
    else if (part === "--scenario-duration-ms")
      args.scenarioDurationMs = Number(argv[++i] ?? args.scenarioDurationMs);
    else if (part === "--scenario-step-ms")
      args.scenarioStepMs = Number(argv[++i] ?? args.scenarioStepMs);
    else if (part === "--scenario-second-delay-ms")
      args.scenarioSecondDelayMs = Number(argv[++i] ?? args.scenarioSecondDelayMs);
    else if (part === "--scenario-second-duration-ms")
      args.scenarioSecondDurationMs = Number(argv[++i] ?? args.scenarioSecondDurationMs);
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
      "  --final-only",
      "  --json",
      "  --login           Login/update session only",
      "  --with-model <alias>",
      "  --restore-previous-model",
      "  --with-verbose <on|off>",
      "  --restore-previous-verbose",
      "  --scenario <name>",
      "  --scenario-secret <token>",
      "  --scenario-duration-ms <n>",
      "  --scenario-step-ms <n>",
      "  --scenario-second-delay-ms <n>",
      "  --scenario-second-duration-ms <n>",
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

function acquireLiveLock() {
  try {
    const fd = fs.openSync(LIVE_LOCK_PATH, "wx");
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    return () => {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.unlinkSync(LIVE_LOCK_PATH);
      } catch {}
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const details = fs.existsSync(LIVE_LOCK_PATH) ? fs.readFileSync(LIVE_LOCK_PATH, "utf8") : "";
      fail(
        `Another telegram-live session is already running.${details ? `\n${details.trim()}` : ""}`,
      );
    }
    throw error;
  }
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
  const sentMessage = await client.sendMessage(entity, { message: args.prompt });
  const sentMessageId = Number(sentMessage?.id ?? 0);

  const deadline = Date.now() + args.timeoutMs;
  let transcript = [];
  let lastTranscriptSignature = "";
  let lastTranscriptChangeAt = 0;

  while (Date.now() < deadline) {
    const messages = await client.getMessages(entity, { limit: 20 });
    transcript = pickReply(messages, sentMessageId - 1);
    const signature = JSON.stringify(transcript);
    if (signature !== lastTranscriptSignature) {
      lastTranscriptSignature = signature;
      lastTranscriptChangeAt = Date.now();
    }

    const extraOutgoing = transcript.find(
      (message) => message.direction === "me" && message.id > sentMessageId,
    );
    if (extraOutgoing) {
      throw new Error(
        `Detected another outbound message in the same chat while waiting for a live reply: ${extraOutgoing.text}`,
      );
    }

    const botReplies = transcript.filter((message) => message.direction === "bot");
    const nonThinkingReplies = botReplies.filter(
      (message) => message.text && message.text !== "Thinking...",
    );
    const completionReplies = nonThinkingReplies.filter((message) => !isTraceMessage(message));

    if (nonThinkingReplies.length) {
      const quietMs = hasTraceMessages(nonThinkingReplies) ? TRACE_QUIET_MS : DEFAULT_QUIET_MS;
      if (Date.now() - lastTranscriptChangeAt >= quietMs && !hasPendingToolTrace(botReplies)) {
        const targetReplies =
          args.finalOnly || hasTraceMessages(nonThinkingReplies) ? completionReplies : botReplies;
        if (!targetReplies.length) {
          await sleep(args.pollMs);
          continue;
        }
        const expectationsMet = transcriptMatches(targetReplies, args.expect, args.reject);
        if (!args.expect.length || expectationsMet) {
          assertTranscript(targetReplies, args.expect, args.reject);
          return { ok: true, bot, prompt: args.prompt, transcript };
        }
      }
    }

    await sleep(args.pollMs);
  }

  const transcriptText = transcript.length
    ? transcript.map((item) => `- ${item.direction}#${item.id}: ${item.text}`).join("\n")
    : "(no transcript)";
  throw new Error(
    `Timed out after ${args.timeoutMs}ms waiting for bot reply\nTranscript so far:\n${transcriptText}`,
  );
}

async function sendPromptMessage(client, bot, prompt) {
  const entity = await client.getEntity(bot);
  const sent = await client.sendMessage(entity, { message: prompt });
  return { entity, messageId: Number(sent?.id ?? 0) };
}

function createScenarioId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildLongRunScenarioPrompt(args, runId, durationMs) {
  return [
    "LIVE_TEST_SCENARIO",
    "long-run-queue",
    `run=${runId}`,
    `secret=${args.scenarioSecret}`,
    `duration_ms=${durationMs}`,
    `step_ms=${args.scenarioStepMs}`,
  ].join(" ");
}

async function runLongRunQueueScenario(client, args) {
  const bot = normalizeUsername(args.bot);
  if (!bot) fail("Missing bot username. Set TELEGRAM_TEST_BOT_USERNAME or pass --bot");
  if (!args.scenarioSecret.trim()) {
    fail(
      "Missing live test scenario secret. Pass --scenario-secret or set LIVE_TEST_SCENARIO_SECRET",
    );
  }

  const firstRunId = `${createScenarioId()}-1`;
  const secondRunId = `${createScenarioId()}-2`;
  const firstPrompt = buildLongRunScenarioPrompt(args, firstRunId, args.scenarioDurationMs);
  const secondPrompt = buildLongRunScenarioPrompt(args, secondRunId, args.scenarioSecondDurationMs);
  const expectedFirst = `LIVE_TEST long-run-queue complete run=${firstRunId}`;
  const expectedSecond = `LIVE_TEST long-run-queue complete run=${secondRunId}`;

  const first = await sendPromptMessage(client, bot, firstPrompt);
  await sleep(args.scenarioSecondDelayMs);
  const second = await sendPromptMessage(client, bot, secondPrompt);

  const sentIds = new Set([first.messageId, second.messageId]);
  const deadline = Date.now() + args.timeoutMs;
  let transcript = [];

  while (Date.now() < deadline) {
    const messages = await client.getMessages(first.entity, { limit: 50 });
    transcript = pickReply(messages, first.messageId - 1);
    const joined = transcript.map((item) => item.text).join("\n");

    const extraOutgoing = transcript.find(
      (message) => message.direction === "me" && !sentIds.has(message.id),
    );
    if (extraOutgoing) {
      throw new Error(
        `Detected another outbound message in the same chat while waiting for a live reply: ${extraOutgoing.text}`,
      );
    }

    if (joined.includes("Currently busy. Not executed. Use /status or /stop.")) {
      throw new Error("Second message was rejected as busy instead of being queued.");
    }
    if (joined.includes("Live test scenario unauthorized.")) {
      throw new Error("Live test scenario was rejected by the staging worker.");
    }

    const firstIndex = joined.indexOf(expectedFirst);
    const secondIndex = joined.indexOf(expectedSecond);
    if (firstIndex >= 0 && secondIndex > firstIndex) {
      return {
        ok: true,
        bot,
        prompt: `scenario:${args.scenario}`,
        transcript,
        scenario: {
          name: "long-run-queue",
          firstRunId,
          secondRunId,
        },
      };
    }

    await sleep(args.pollMs);
  }

  const transcriptText = transcript.length
    ? transcript.map((item) => `- ${item.direction}#${item.id}: ${item.text}`).join("\n")
    : "(no transcript)";
  throw new Error(
    `Timed out after ${args.timeoutMs}ms waiting for scenario completion\nTranscript so far:\n${transcriptText}`,
  );
}

function transcriptMatches(transcript, expect, reject) {
  const joined = transcript.map((item) => item.text).join("\n");
  for (const needle of expect) {
    if (needle && !joined.includes(needle)) return false;
  }
  for (const needle of reject) {
    if (needle && joined.includes(needle)) return false;
  }
  return true;
}

function hasTraceMessages(transcript) {
  return transcript.some(
    (item) => item.text.startsWith("Tool: ") || item.text.startsWith("Tool result: "),
  );
}

function hasPendingToolTrace(transcript) {
  let started = 0;
  let finished = 0;
  for (const item of transcript) {
    if (item.text.startsWith("Tool: ")) started += 1;
    if (item.text.startsWith("Tool result: ")) finished += 1;
  }
  return started > finished;
}

function isTraceMessage(message) {
  return message.text.startsWith("Tool: ") || message.text.startsWith("Tool result: ");
}

function extractCurrentAlias(transcript) {
  const joined = transcript.map((item) => item.text).join("\n");
  const match = joined.match(/current:\s*([a-z0-9-]+)/i);
  return match?.[1]?.trim().toLowerCase() || "";
}

function extractVerboseSetting(transcript) {
  const joined = transcript
    .map((item) => item.text)
    .join("\n")
    .toLowerCase();
  if (joined.includes("verbose: on") || joined.includes("verbose enabled.")) return "on";
  if (joined.includes("verbose: off") || joined.includes("verbose disabled.")) return "off";
  return "";
}

async function runCommand(client, args, prompt) {
  const result = await runPrompt(client, {
    ...args,
    prompt,
    expect: [],
    reject: [],
  });
  return {
    ...result,
    currentAlias: extractCurrentAlias(result.transcript),
    currentVerbose: extractVerboseSetting(result.transcript),
  };
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
  loadDotEnvIntoProcess(path.join(process.cwd(), ".env"));
  const args = parseArgs(process.argv.slice(2));
  const releaseLock = acquireLiveLock();
  const client = await connectClient(args);
  let restoreAlias = "";
  let restoreVerbose = "";
  try {
    if (args.loginOnly) {
      if (await client.isUserAuthorized()) process.stdout.write("Telegram test session ready.\n");
      return;
    }

    if (args.scenario.trim()) {
      if (args.scenario !== "long-run-queue") {
        fail(`Unknown scenario: ${args.scenario}`);
      }
      const result = await runLongRunQueueScenario(client, args);
      printResult(result, args.json);
      return;
    }

    if (args.withModel.trim()) {
      const requestedAlias = args.withModel.trim().toLowerCase();
      const current = await runCommand(client, args, "/model");
      const currentAlias = current.currentAlias;
      if (!currentAlias) fail("Could not determine current model alias from /model reply");
      if (args.restorePreviousModel) restoreAlias = currentAlias;
      if (currentAlias !== requestedAlias) {
        await runCommand(client, args, `/model ${requestedAlias}`);
      }
    }

    if (args.withVerbose.trim()) {
      const requestedVerbose = args.withVerbose.trim().toLowerCase();
      if (!["on", "off"].includes(requestedVerbose)) {
        fail("--with-verbose must be 'on' or 'off'");
      }
      const current = await runCommand(client, args, "/verbose");
      const currentVerbose = current.currentVerbose;
      if (!currentVerbose) fail("Could not determine current verbose setting from /verbose reply");
      if (args.restorePreviousVerbose) restoreVerbose = currentVerbose;
      if (currentVerbose !== requestedVerbose) {
        await runCommand(client, args, `/verbose ${requestedVerbose}`);
      }
    }

    const result = await runPrompt(client, args);
    printResult(result, args.json);
  } finally {
    if (restoreAlias) {
      try {
        await runCommand(client, args, `/model ${restoreAlias}`);
      } catch (error) {
        process.stderr.write(
          `Failed to restore previous model alias (${restoreAlias}): ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    if (restoreVerbose) {
      try {
        await runCommand(client, args, `/verbose ${restoreVerbose}`);
      } catch (error) {
        process.stderr.write(
          `Failed to restore previous verbose setting (${restoreVerbose}): ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    await client.destroy();
    releaseLock();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unexpected Telegram live test failure");
});
