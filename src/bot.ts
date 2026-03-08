import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Message, type Thread } from "chat";
import { BotRuntime } from "./app/runtime";
import { normalizeBotThreadState, type BotThreadState } from "./app/state";
import { createD1StateAdapter } from "./chat-state";
import {
  getPersistedRunStatus,
  getPersistedThreadControls,
  getThreadStateSnapshot,
  requestPersistedRunStop,
  setPersistedThreadControls,
  setThreadStateSnapshot,
} from "./db";
import { sendTelegramTextMessage } from "./telegram-api";
import type { Env, TelegramUpdate } from "./types";

export function createBot(env: Env) {
  const adapters = {
    telegram: createTelegramAdapter({
      botToken: env.TELEGRAM_BOT_TOKEN,
      secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      userName: env.TELEGRAM_BOT_USERNAME,
    }),
  };
  const runtime = new BotRuntime(env);
  const bot = new Chat<typeof adapters, BotThreadState>({
    adapters,
    state: createD1StateAdapter(env.DRECLAW_DB),
    userName: env.TELEGRAM_BOT_USERNAME || "dreclaw",
    fallbackStreamingPlaceholderText: "Thinking...",
    streamingUpdateIntervalMs: 700,
    logger: "info",
  });

  const handleIncoming = async (thread: Thread<BotThreadState>, message: Message, subscribe: boolean) => {
    if (!isTelegramPrivateMessage(message.raw)) return;
    if (!isAllowedUser(env, message)) return;
    const text = message.text.trim();

    if (text.startsWith("/")) {
      await handleAsyncCommand({
        env,
        runtime,
        threadId: thread.id,
        chatId: getTelegramUserChatId(message.raw, thread.id),
        telegramUserId: Number(message.author.userId || 0),
        text,
      });
      return;
    }

    if (subscribe) await thread.subscribe();

    let currentState = normalizeBotThreadState(await thread.state);
    const controls = await getPersistedThreadControls(env.DRECLAW_DB, thread.id);
    if (controls) currentState = { ...currentState, verbose: controls.verbose };
    const nextState = await runtime.runConversation({ thread, message, state: currentState });
    await thread.setState(nextState, { replace: true });
  };

  bot.onNewMessage(/^.*$/s, async (thread, message) => handleIncoming(thread, message, true));
  bot.onSubscribedMessage(async (thread, message) => handleIncoming(thread, message, false));
  return bot;
}

export async function maybeHandleAsyncTelegramCommand(env: Env, update: TelegramUpdate): Promise<boolean> {
  const message = update.message;
  const text = message?.text?.trim() ?? "";
  if (!message || !text.startsWith("/")) return false;
  if (message.chat.type !== "private") return false;
  if (String(message.from?.id ?? "") !== String(env.TELEGRAM_ALLOWED_USER_ID).trim()) return false;

  await handleAsyncCommand({
    env,
    runtime: new BotRuntime(env),
    threadId: `telegram:${message.chat.id}`,
    chatId: message.chat.id,
    telegramUserId: Number(message.from?.id ?? 0),
    text,
  });
  return true;
}

async function handleAsyncCommand(params: {
  env: Env;
  runtime: BotRuntime;
  threadId: string;
  chatId: number;
  telegramUserId: number;
  text: string;
}): Promise<void> {
  const { env, runtime, threadId, chatId, telegramUserId, text } = params;
  const [command, value] = text.split(/\s+/, 2);
  const lowered = command.toLowerCase();
  const state = normalizeBotThreadState(await getThreadStateSnapshot<BotThreadState>(env.DRECLAW_DB, threadId));
  const controls = await getPersistedThreadControls(env.DRECLAW_DB, threadId);
  const controlledState = controls ? { ...state, verbose: controls.verbose } : state;
  const runStatus = (await getPersistedRunStatus(env.DRECLAW_DB, threadId)) ?? controlledState.runStatus;
  const busy = isRunBusy(runStatus);

  if (lowered === "/help") {
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, runtime.help());
    return;
  }

  if (lowered === "/status") {
    await sendTelegramTextMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      await runtime.status(threadId, {
        ...controlledState,
        runStatus,
      }),
    );
    return;
  }

  if (lowered === "/stop") {
    if (!runStatus.running) {
      await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Nothing is running.");
      return;
    }
    await requestPersistedRunStop(env.DRECLAW_DB, threadId);
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Stopping current run...");
    return;
  }

  if (lowered === "/reset") {
    if (busy) {
      await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, busyMessage(lowered));
      return;
    }
    const next = runtime.reset(controlledState);
    await setPersistedThreadControls(env.DRECLAW_DB, threadId, { verbose: false });
    await setThreadStateSnapshot(env.DRECLAW_DB, threadId, next);
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Session reset. Conversation context cleared.");
    return;
  }

  if (lowered === "/factory-reset") {
    if (busy) {
      await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, busyMessage(lowered));
      return;
    }
    const next = await runtime.factoryReset(chatId);
    await setPersistedThreadControls(env.DRECLAW_DB, threadId, { verbose: false });
    await setThreadStateSnapshot(env.DRECLAW_DB, threadId, next);
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Factory reset complete. Conversation, memory, runtime state, and VFS cleared.");
    return;
  }

  if (lowered === "/verbose") {
    if (value !== "on" && value !== "off") {
      await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, `verbose: ${state.verbose ? "on" : "off"}\nusage: /verbose on|off`);
      return;
    }
    const next = runtime.setVerbose(controlledState, value === "on");
    await setPersistedThreadControls(env.DRECLAW_DB, threadId, { verbose: value === "on" });
    await setThreadStateSnapshot(env.DRECLAW_DB, threadId, next);
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, `verbose ${value === "on" ? "enabled" : "disabled"}.`);
    return;
  }

  if (lowered === "/google") {
    const action = text.split(/\s+/, 3)[1]?.toLowerCase() ?? "";
    if (busy && (action === "connect" || action === "disconnect")) {
      await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, busyMessage(`/google ${action}`));
      return;
    }
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, await runtime.handleGoogleCommand(text, chatId, telegramUserId));
    return;
  }

  await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, runtime.help());
}

function isAllowedUser(env: Env, message: Message): boolean {
  return String(message.author.userId) === String(env.TELEGRAM_ALLOWED_USER_ID).trim();
}

function isTelegramPrivateMessage(raw: unknown): boolean {
  return ((raw as { chat?: { type?: string } })?.chat?.type || "") === "private";
}

function getTelegramUserChatId(raw: unknown, threadId: string): number {
  const chatId = (raw as { chat?: { id?: number } })?.chat?.id;
  if (typeof chatId === "number") return chatId;
  const fromThread = Number(threadId.split(":").at(-1));
  if (Number.isFinite(fromThread)) return fromThread;
  throw new Error("Missing Telegram chat id");
}

function isRunBusy(runStatus: BotThreadState["runStatus"]): boolean {
  if (!runStatus.running || !runStatus.lastHeartbeatAt) return false;
  const deltaMs = Date.now() - Date.parse(runStatus.lastHeartbeatAt);
  return Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs <= 15_000;
}

function busyMessage(command: string): string {
  return `Currently busy. Not executed. Run ${command} again when not busy.`;
}
