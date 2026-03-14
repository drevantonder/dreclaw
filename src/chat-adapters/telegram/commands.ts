import { BotRuntime } from "../../app/runtime";
import { normalizeBotThreadState, type BotThreadState } from "../../app/state";
import {
  getThreadStateSnapshot,
  setPersistedThreadControls,
  setThreadStateSnapshot,
} from "../../db";
import { createRunCoordinator } from "../../run";
import type { Env, TelegramUpdate } from "../../types";
import { sendTelegramTextMessage } from "./api";
import { isAllowedTelegramUpdate } from "./auth";
import { isPrivateTelegramUpdate } from "./message";

export async function maybeHandleAsyncTelegramCommand(
  env: Env,
  update: TelegramUpdate,
  schedule?: (promise: Promise<unknown>) => void,
  executionContext?: ExecutionContext,
): Promise<boolean> {
  const message = update.message;
  const text = message?.text?.trim() ?? "";
  if (!message || !text.startsWith("/")) return false;
  if (!isPrivateTelegramUpdate(update)) return false;
  if (!isAllowedTelegramUpdate(env, update)) return false;

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

export async function handleAsyncCommand(params: {
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

function busyMessage(command: string): string {
  return `Currently busy. Not executed. Run ${command} again when not busy.`;
}
