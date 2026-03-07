import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Message, type Thread } from "chat";
import { BotRuntime } from "./app/runtime";
import { normalizeBotThreadState, type BotThreadState } from "./app/state";
import { createD1StateAdapter } from "./chat-state";
import type { Env } from "./types";

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
    if (subscribe) await thread.subscribe();

    const currentState = normalizeBotThreadState(await thread.state);
    const text = message.text.trim();

    if (text.startsWith("/")) {
      const nextState = await handleCommand(runtime, thread, message, currentState, text);
      await thread.setState(nextState, { replace: true });
      return;
    }

    const nextState = await runtime.runConversation({ thread, message, state: currentState });
    await thread.setState(nextState, { replace: true });
  };

  bot.onNewMessage(/^.*$/s, async (thread, message) => handleIncoming(thread, message, true));
  bot.onSubscribedMessage(async (thread, message) => handleIncoming(thread, message, false));
  return bot;
}

async function handleCommand(
  runtime: BotRuntime,
  thread: Thread<BotThreadState>,
  message: Message,
  state: BotThreadState,
  text: string,
): Promise<BotThreadState> {
  const [command, value] = text.split(/\s+/, 2);
  const lowered = command.toLowerCase();

  if (lowered === "/help") {
    await thread.post(runtime.help());
    return state;
  }
  if (lowered === "/status") {
    await thread.post(await runtime.status(thread.id, state));
    return state;
  }
  if (lowered === "/reset") {
    const next = runtime.reset(state);
    await thread.post("Session reset. Conversation context cleared.");
    return next;
  }
  if (lowered === "/factory-reset") {
    const next = await runtime.factoryReset(getTelegramUserChatId(message.raw, thread.id));
    await thread.post("Factory reset complete. Conversation, memory, runtime state, and VFS cleared.");
    return next;
  }
  if (lowered === "/verbose") {
    if (value !== "on" && value !== "off") {
      await thread.post(`verbose: ${state.verbose ? "on" : "off"}\nusage: /verbose on|off`);
      return state;
    }
    const next = runtime.setVerbose(state, value === "on");
    await thread.post(`verbose ${value === "on" ? "enabled" : "disabled"}.`);
    return next;
  }
  if (lowered === "/google") {
    await thread.post(await runtime.handleGoogleCommand(text, getTelegramUserChatId(message.raw, thread.id), Number(message.author.userId || 0)));
    return state;
  }

  await thread.post(runtime.help());
  return state;
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
