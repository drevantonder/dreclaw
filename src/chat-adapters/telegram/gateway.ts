import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Message, type SerializedThread, type Thread } from "chat";
import { buildRuntimeDeps } from "../../app/deps";
import {
  BotRuntime,
  createD1StateAdapter,
  createRunCoordinator,
  normalizeBotThreadState,
  type BotThreadState,
} from "../../core";
import { getRemindersPlugin } from "../../plugins/reminders";
import type { Env } from "../../cloudflare/env";
import { isAllowedTelegramMessage } from "./auth";
import { handleAsyncCommand } from "./commands";
import { getTelegramUserChatId, isTelegramPrivateMessage } from "./message";

const chatCache = new WeakMap<Env, Chat<any, BotThreadState>>();
const contextCache = new Map<string, ExecutionContext>();

function getTelegramContextKey(raw: unknown): string | null {
  const chatId = (raw as { chat?: { id?: number } })?.chat?.id;
  const messageId = (raw as { message_id?: number })?.message_id;
  return typeof chatId === "number" && typeof messageId === "number"
    ? `${chatId}:${messageId}`
    : null;
}

function takeTelegramExecutionContext(raw: unknown): ExecutionContext | undefined {
  const key = getTelegramContextKey(raw);
  if (!key) return undefined;
  const context = contextCache.get(key);
  contextCache.delete(key);
  return context;
}

export function rememberTelegramExecutionContext(raw: unknown, ctx: ExecutionContext): void {
  const key = getTelegramContextKey(raw);
  if (!key) return;
  contextCache.set(key, ctx);
}

export function createChat(env: Env) {
  const cached = chatCache.get(env);
  if (cached) return cached;
  const adapters = {
    telegram: createTelegramAdapter({
      botToken: env.TELEGRAM_BOT_TOKEN,
      secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      userName: env.TELEGRAM_BOT_USERNAME,
      mode: "webhook",
    }),
  };
  const chat = new Chat<typeof adapters, BotThreadState>({
    adapters,
    state: createD1StateAdapter(env.DRECLAW_DB),
    userName: env.TELEGRAM_BOT_USERNAME || "dreclaw",
    fallbackStreamingPlaceholderText: null,
    streamingUpdateIntervalMs: 700,
    logger: "info",
  });
  chatCache.set(env, chat);
  return chat;
}

export function createBot(env: Env, executionContext?: ExecutionContext) {
  const runtimeDeps = buildRuntimeDeps(env);
  const runs = createRunCoordinator({
    db: runtimeDeps.DRECLAW_DB,
    workflow: runtimeDeps.CONVERSATION_WORKFLOW,
  });
  const bot = createChat(env);

  const handleIncoming = async (
    thread: Thread<BotThreadState>,
    message: Message,
    subscribe: boolean,
  ) => {
    const requestExecutionContext = takeTelegramExecutionContext(message.raw) ?? executionContext;
    const runtime = new BotRuntime(runtimeDeps, requestExecutionContext as never);
    if (!isTelegramPrivateMessage(message.raw)) return;
    if (!isAllowedTelegramMessage(env, message)) return;
    const text = message.text.trim();
    const chatId = getTelegramUserChatId(message.raw, thread.id);

    if (text.startsWith("/")) {
      await getRemindersPlugin(
        runtimeDeps.pluginRegistry.getByName("reminders"),
      ).ensureReminderProfile({
        primaryChatId: chatId,
      });
      await handleAsyncCommand({
        env,
        runtime,
        threadId: thread.id,
        chatId,
        telegramUserId: Number(message.author.userId || 0),
        text,
      });
      return;
    }

    if (subscribe) await thread.subscribe();

    const currentState = await runs.recoverState(
      thread.id,
      normalizeBotThreadState(await thread.state),
    );
    const run = await runs.inspect(thread.id, currentState);
    if (run.busy) {
      await thread.post("Currently busy. Not executed. Use /status or /stop.");
      return;
    }
    await startConversationWorkflow(env, thread, message, currentState, chatId);
  };

  if (
    !(bot as Chat<any, BotThreadState> & { __dreclawHandlersBound?: boolean })
      .__dreclawHandlersBound
  ) {
    bot.onNewMessage(/^.*$/s, async (thread, message) => handleIncoming(thread, message, true));
    bot.onSubscribedMessage(async (thread, message) => handleIncoming(thread, message, false));
    (
      bot as Chat<any, BotThreadState> & { __dreclawHandlersBound?: boolean }
    ).__dreclawHandlersBound = true;
  }
  return bot;
}

export async function startConversationWorkflow(
  env: Env,
  thread: Thread<BotThreadState>,
  message: Message,
  state: BotThreadState,
  chatId: number,
): Promise<string> {
  const runtimeDeps = buildRuntimeDeps(env);
  if (!runtimeDeps.CONVERSATION_WORKFLOW) {
    throw new Error("Missing CONVERSATION_WORKFLOW binding");
  }
  return createRunCoordinator({
    db: runtimeDeps.DRECLAW_DB,
    workflow: runtimeDeps.CONVERSATION_WORKFLOW,
  }).startWorkflowRun({
    thread: thread as Thread<BotThreadState> & { toJSON(): SerializedThread },
    message,
    state,
    channelId: chatId,
  });
}
