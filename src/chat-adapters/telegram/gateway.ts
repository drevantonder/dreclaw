import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Message, type SerializedThread, type Thread } from "chat";
import { BotRuntime } from "../../app/runtime";
import { normalizeBotThreadState, type BotThreadState } from "../../app/state";
import { createD1StateAdapter } from "../../chat-state";
import { createRunCoordinator } from "../../run";
import type { Env } from "../../types";
import { isAllowedTelegramMessage } from "./auth";
import { handleAsyncCommand } from "./commands";
import {
  getTelegramUserChatId,
  isTelegramPrivateMessage,
  loadTelegramImageBlocks,
} from "./message";

export function createChat(env: Env) {
  const adapters = {
    telegram: createTelegramAdapter({
      botToken: env.TELEGRAM_BOT_TOKEN,
      secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      userName: env.TELEGRAM_BOT_USERNAME,
    }),
  };
  return new Chat<typeof adapters, BotThreadState>({
    adapters,
    state: createD1StateAdapter(env.DRECLAW_DB),
    userName: env.TELEGRAM_BOT_USERNAME || "dreclaw",
    fallbackStreamingPlaceholderText: null,
    streamingUpdateIntervalMs: 700,
    logger: "info",
  });
}

export function createBot(env: Env, executionContext?: ExecutionContext) {
  const runtime = new BotRuntime(env, executionContext);
  const runs = createRunCoordinator(env);
  const bot = createChat(env);

  const handleIncoming = async (
    thread: Thread<BotThreadState>,
    message: Message,
    subscribe: boolean,
  ) => {
    if (!isTelegramPrivateMessage(message.raw)) return;
    if (!isAllowedTelegramMessage(env, message)) return;
    const text = message.text.trim();
    const chatId = getTelegramUserChatId(message.raw, thread.id);
    const imageBlocks = await loadTelegramImageBlocks(env.TELEGRAM_BOT_TOKEN, message.raw);

    if (text.startsWith("/")) {
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
    if (!env.CONVERSATION_WORKFLOW) {
      const nextState = await runtime.runConversation({
        thread,
        message,
        chatId,
        state: currentState,
        imageBlocks,
      });
      await thread.setState(nextState, { replace: true });
      return;
    }
    await startConversationWorkflow(env, thread, message, currentState);
  };

  bot.onNewMessage(/^.*$/s, async (thread, message) => handleIncoming(thread, message, true));
  bot.onSubscribedMessage(async (thread, message) => handleIncoming(thread, message, false));
  return bot;
}

export async function startConversationWorkflow(
  env: Env,
  thread: Thread<BotThreadState>,
  message: Message,
  state: BotThreadState,
): Promise<string> {
  return createRunCoordinator(env).startWorkflowRun({
    thread: thread as Thread<BotThreadState> & { toJSON(): SerializedThread },
    message,
    state,
  });
}
