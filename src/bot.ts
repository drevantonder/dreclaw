import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Message, type SerializedThread, type Thread } from "chat";
import { BotRuntime } from "./app/runtime";
import { normalizeBotThreadState, type BotThreadState } from "./app/state";
import { createD1StateAdapter } from "./chat-state";
import { getThreadStateSnapshot, setPersistedThreadControls, setThreadStateSnapshot } from "./db";
import { createRunCoordinator } from "./run";
import { sendTelegramTextMessage } from "./telegram-api";
import type { Env, TelegramUpdate } from "./types";

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
      const nextState = await runtime.runConversation({ thread, message, state: currentState });
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

export async function maybeHandleAsyncTelegramCommand(
  env: Env,
  update: TelegramUpdate,
  schedule?: (promise: Promise<unknown>) => void,
  executionContext?: ExecutionContext,
): Promise<boolean> {
  const message = update.message;
  const text = message?.text?.trim() ?? "";
  if (!message || !text.startsWith("/")) return false;
  if (message.chat.type !== "private") return false;
  if (String(message.from?.id ?? "") !== String(env.TELEGRAM_ALLOWED_USER_ID).trim()) return false;

  await handleAsyncCommand({
    env,
    runtime: new BotRuntime(env, executionContext),
    threadId: `telegram:${message.chat.id}`,
    chatId: message.chat.id,
    telegramUserId: Number(message.from?.id ?? 0),
    text,
    schedule,
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
  schedule?: (promise: Promise<unknown>) => void;
}): Promise<void> {
  const { env, runtime, threadId, chatId, telegramUserId, text } = params;
  const [command, value] = text.split(/\s+/, 2);
  const lowered = command.toLowerCase();
  const runs = createRunCoordinator(env);
  const snapshot = normalizeBotThreadState(
    await getThreadStateSnapshot<BotThreadState>(env.DRECLAW_DB, threadId),
  );
  const controlledState = await runs.recoverState(threadId, snapshot);
  const status = await runs.getStatus(threadId, controlledState);
  const busy = status.busy === "yes";

  if (lowered === "/help") {
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, runtime.help());
    return;
  }

  if (lowered === "/status") {
    const workflowStatus = await runs.getWorkflowStatus(threadId, controlledState);
    await sendTelegramTextMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      [
        await runtime.status(threadId, {
          ...controlledState,
          runStatus: status.runStatus,
        }),
        workflowStatus ? `workflow: ${workflowStatus}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    return;
  }

  if (lowered === "/stop") {
    if (!status.runStatus.running) {
      await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Nothing is running.");
      return;
    }
    await runs.requestStop(threadId, controlledState);
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Stopped.");
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
    await sendTelegramTextMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Session reset. Conversation context cleared.",
    );
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
    await sendTelegramTextMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "Factory reset complete. Conversation, memory, and VFS cleared.",
    );
    return;
  }

  if (lowered === "/verbose") {
    if (value !== "on" && value !== "off") {
      await sendTelegramTextMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        `verbose: ${snapshot.verbose ? "on" : "off"}\nusage: /verbose on|off`,
      );
      return;
    }
    const next = runtime.setVerbose(controlledState, value === "on");
    await setPersistedThreadControls(env.DRECLAW_DB, threadId, { verbose: value === "on" });
    await setThreadStateSnapshot(env.DRECLAW_DB, threadId, next);
    await sendTelegramTextMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      `verbose ${value === "on" ? "enabled" : "disabled"}.`,
    );
    return;
  }

  if (lowered === "/google") {
    const action = text.split(/\s+/, 3)[1]?.toLowerCase() ?? "";
    if (busy && (action === "connect" || action === "disconnect")) {
      await sendTelegramTextMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        busyMessage(`/google ${action}`),
      );
      return;
    }
    await sendTelegramTextMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      await runtime.handleGoogleCommand(text, chatId, telegramUserId),
    );
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

function busyMessage(command: string): string {
  return `Currently busy. Not executed. Run ${command} again when not busy.`;
}
