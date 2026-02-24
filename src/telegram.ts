import type { TelegramMessage, TelegramUpdate } from "./types";

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_MAX_TEXT_LENGTH = 3900;

type TelegramParseMode = "HTML" | "MarkdownV2";

interface TelegramSendOptions {
  parseMode?: TelegramParseMode;
  disableWebPagePreview?: boolean;
}

export function parseUpdate(body: unknown): TelegramUpdate | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;
  if (typeof data.update_id !== "number") return null;
  return {
    update_id: data.update_id,
    message: isTelegramMessage(data.message) ? data.message : undefined,
  };
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  const chat = msg.chat as Record<string, unknown> | undefined;
  return typeof msg.message_id === "number" && typeof msg.date === "number" && Boolean(chat && typeof chat.id === "number");
}

export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  options: TelegramSendOptions = {},
): Promise<number | null> {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const parseMode = options.parseMode ?? "HTML";
  const safeText = clampTelegramText(parseMode === "HTML" ? formatTelegramHtml(text) : text);
  const body = {
    chat_id: chatId,
    text: safeText,
    parse_mode: parseMode,
    disable_web_page_preview: options.disableWebPagePreview ?? true,
  };

  return withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Telegram send failed (${response.status}): ${payload}`);
    }
    const payload = (await response.json()) as { result?: { message_id?: number } };
    return payload.result?.message_id ?? null;
  });
}

export async function editTelegramMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  options: TelegramSendOptions = {},
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${token}/editMessageText`;
  const parseMode = options.parseMode ?? "HTML";
  const safeText = clampTelegramText(parseMode === "HTML" ? formatTelegramHtml(text) : text);
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: safeText,
    parse_mode: parseMode,
    disable_web_page_preview: options.disableWebPagePreview ?? true,
  };

  await withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Telegram edit failed (${response.status}): ${payload}`);
    }
  });
}

export async function sendTelegramChatAction(token: string, chatId: number, action = "typing"): Promise<void> {
  const url = `${TELEGRAM_API}/bot${token}/sendChatAction`;
  const body = {
    chat_id: chatId,
    action,
  };

  await withRetry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Telegram chat action failed (${response.status}): ${payload}`);
    }
  });
}

function clampTelegramText(input: string): string {
  const normalized = String(input ?? "").trim();
  if (!normalized) return "Done.";
  if (normalized.length <= TELEGRAM_MAX_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, TELEGRAM_MAX_TEXT_LENGTH - 1)}…`;
}

export function formatTelegramHtml(input: string): string {
  const normalized = String(input ?? "").trim();
  if (!normalized) return "Done.";
  return normalized
    .split("\n")
    .map((line) => formatTelegramHtmlLine(line))
    .join("\n");
}

function formatTelegramHtmlLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0) {
    return escapeTelegramHtml(trimmed);
  }

  const rawLabel = trimmed.slice(0, separatorIndex);
  const rawValue = trimmed.slice(separatorIndex + 1).trimStart();
  if (!isTelegramStyledLabel(rawLabel)) {
    return escapeTelegramHtml(trimmed);
  }

  if (!rawValue) {
    return `<b>${escapeTelegramHtml(rawLabel)}:</b>`;
  }
  if (shouldRenderCodeValue(rawLabel)) {
    return `<b>${escapeTelegramHtml(rawLabel)}:</b> <code>${escapeTelegramHtml(rawValue)}</code>`;
  }
  return `<b>${escapeTelegramHtml(rawLabel)}:</b> ${escapeTelegramHtml(rawValue)}`;
}

function isTelegramStyledLabel(label: string): boolean {
  return TELEGRAM_STYLED_LABELS.has(label);
}

function shouldRenderCodeValue(label: string): boolean {
  return TELEGRAM_CODE_VALUE_LABELS.has(label);
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const TELEGRAM_STYLED_LABELS = new Set<string>([
  "Thinking",
  "Tool start",
  "Tool call",
  "Tool ok",
  "Tool error",
  "Tools used",
  "Failed tools",
  "model",
  "session",
  "workspace",
  "workspace_files",
  "provider_auth",
  "history_messages",
  "details",
  "usage",
  "thinking",
]);

const TELEGRAM_CODE_VALUE_LABELS = new Set<string>([
  "Tool start",
  "Tool call",
  "Tool ok",
  "Tool error",
  "Tools used",
  "Failed tools",
  "model",
  "session",
  "workspace",
  "workspace_files",
  "provider_auth",
  "history_messages",
  "details",
  "thinking",
]);

export async function fetchImageAsDataUrl(token: string, fileId: string): Promise<string | null> {
  const getFileUrl = `${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const getFileResponse = await fetch(getFileUrl);
  if (!getFileResponse.ok) return null;
  const fileJson = (await getFileResponse.json()) as { result?: { file_path?: string } };
  const filePath = fileJson.result?.file_path;
  if (!filePath) return null;

  const downloadUrl = `${TELEGRAM_API}/file/bot${token}/${filePath}`;
  const imageResponse = await fetch(downloadUrl);
  if (!imageResponse.ok) return null;

  const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  return `data:${contentType};base64,${base64}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return fn();
  }
}
