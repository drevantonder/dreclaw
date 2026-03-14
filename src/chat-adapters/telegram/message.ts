import { fetchTelegramImageAsDataUrl } from "./api";
import type { TelegramUpdate } from "./types";

export function isTelegramPrivateMessage(raw: unknown): boolean {
  return ((raw as { chat?: { type?: string } })?.chat?.type || "") === "private";
}

export function isPrivateTelegramUpdate(update: TelegramUpdate): boolean {
  return update.message?.chat.type === "private";
}

export function getTelegramUserChatId(raw: unknown, threadId: string): number {
  const chatId = (raw as { chat?: { id?: number } })?.chat?.id;
  if (typeof chatId === "number") return chatId;
  const fromThread = Number(threadId.split(":").at(-1));
  if (Number.isFinite(fromThread)) return fromThread;
  throw new Error("Missing Telegram chat id");
}

export async function loadTelegramImageBlocks(token: string, raw: unknown): Promise<string[]> {
  const photo = (raw as { photo?: Array<{ file_id?: string; file_size?: number }> })?.photo;
  if (!Array.isArray(photo) || !photo.length) return [];
  const best = [...photo].sort((a, b) => Number(b.file_size ?? 0) - Number(a.file_size ?? 0))[0];
  if (!best?.file_id) return [];
  const image = await fetchTelegramImageAsDataUrl(token, best.file_id);
  return image ? [image] : [];
}
