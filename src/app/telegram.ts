import type { AppEffect, ReplyTarget } from "../core/effects";
import { sendTelegramTextMessage } from "../chat-adapters/telegram/api";
import type { Env } from "../cloudflare/env";

export function telegramReplyTarget(chatId: number): ReplyTarget {
  return { channel: "telegram", id: String(chatId) };
}

export async function flushTelegramEffects(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  effects: AppEffect[] | undefined,
): Promise<void> {
  for (const effect of effects ?? []) {
    if (effect.type !== "send-text") continue;
    if (effect.target.channel !== "telegram") continue;
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, Number(effect.target.id), effect.text);
  }
}
