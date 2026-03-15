import { handleAsyncCommand as handleCoreCommand, maybeHandleAsyncCoreCommand } from "../../core";
import { buildCommandDeps } from "../../app/deps";
import { flushTelegramEffects, telegramReplyTarget } from "../../app/telegram";
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

  const result = await maybeHandleAsyncCoreCommand(buildCommandDeps(env, executionContext), {
    threadId: `telegram:${message.chat.id}`,
    channelId: message.chat.id,
    actorId: String(message.from?.id ?? ""),
    replyTarget: telegramReplyTarget(message.chat.id),
    text,
  });
  if (!result) return false;
  await publishTelegramMessages(env, message.chat.id, result.messages);
  await flushTelegramEffects(env, result.effects);
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
    deps: {
      ...buildCommandDeps(params.env),
      runtime: params.runtime,
    },
    input: {
      threadId: params.threadId,
      channelId: params.chatId,
      actorId: String(params.telegramUserId),
      replyTarget: telegramReplyTarget(params.chatId),
      text: params.text,
    },
  });
  await publishTelegramMessages(params.env, params.chatId, result.messages);
  await flushTelegramEffects(params.env, result.effects);
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
