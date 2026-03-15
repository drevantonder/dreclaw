import { handleAsyncCommand as handleCoreCommand, maybeHandleAsyncCoreCommand } from "../../core";
import type { Env } from "../../cloudflare/env";
import { sendTelegramTextMessage } from "./api";
import type { TelegramUpdate } from "./types";
import { isAllowedTelegramUpdate } from "./auth";
import { isPrivateTelegramUpdate } from "./message";

export async function maybeHandleAsyncTelegramCommand(
  env: Env,
  update: TelegramUpdate,
  _schedule?: (promise: Promise<unknown>) => void,
  executionContext?: ExecutionContext,
): Promise<boolean> {
  const message = update.message;
  const text = message?.text?.trim() ?? "";
  if (!message || !text.startsWith("/")) return false;
  if (!isPrivateTelegramUpdate(update)) return false;
  if (!isAllowedTelegramUpdate(env, update)) return false;

  const result = await maybeHandleAsyncCoreCommand(env, {
    threadId: `telegram:${message.chat.id}`,
    chatId: message.chat.id,
    telegramUserId: Number(message.from?.id ?? 0),
    text,
    executionContext,
  });
  if (!result) return false;
  await publishTelegramMessages(env, message.chat.id, result.messages);
  return true;
}

export async function handleAsyncCommand(params: {
  env: Env;
  runtime: any;
  threadId: string;
  chatId: number;
  telegramUserId: number;
  text: string;
}): Promise<void> {
  const result = await handleCoreCommand({
    env: params.env,
    runtime: params.runtime,
    threadId: params.threadId,
    chatId: params.chatId,
    telegramUserId: params.telegramUserId,
    text: params.text,
  });
  await publishTelegramMessages(params.env, params.chatId, result.messages);
}

async function publishTelegramMessages(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  chatId: number,
  messages: string[],
): Promise<void> {
  for (const message of messages) {
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, message);
  }
}
