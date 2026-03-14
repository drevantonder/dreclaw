import type { Message } from "chat";
import type { Env } from "../../cloudflare/env";
import type { TelegramUpdate } from "./types";

export function isAllowedTelegramMessage(env: Env, message: Message): boolean {
  return String(message.author.userId) === String(env.TELEGRAM_ALLOWED_USER_ID).trim();
}

export function isAllowedTelegramUpdate(env: Env, update: TelegramUpdate): boolean {
  return String(update.message?.from?.id ?? "") === String(env.TELEGRAM_ALLOWED_USER_ID).trim();
}

export function hasValidTelegramWebhookSecret(request: Request, env: Env): boolean {
  return request.headers.get("x-telegram-bot-api-secret-token") === env.TELEGRAM_WEBHOOK_SECRET;
}
