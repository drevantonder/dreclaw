import {
  handleAsyncCommand as handleCoreCommand,
  maybeHandleAsyncCoreCommand,
  publishCommandResult,
} from "../../core";
import type { Env } from "../../cloudflare/env";
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

  return maybeHandleAsyncCoreCommand(env, {
    threadId: `telegram:${message.chat.id}`,
    chatId: message.chat.id,
    telegramUserId: Number(message.from?.id ?? 0),
    text,
    executionContext,
  });
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
  await publishCommandResult(params.env, params.chatId, result.messages);
}
