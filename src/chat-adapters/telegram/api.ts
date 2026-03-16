import type { Profiler } from "../../core/profiling";

const TELEGRAM_API = "https://api.telegram.org";

const TELEGRAM_DEFAULT_STREAM_UPDATE_INTERVAL_MS = 350;

type TelegramSendMessageResult = {
  ok?: boolean;
  result?: {
    message_id?: number;
    chat?: { id?: number; type?: string };
    text?: string;
  };
  description?: string;
};

export async function sendTelegramTextMessage(
  token: string,
  chatId: number,
  text: string,
  profiler?: Profiler,
): Promise<{ messageId: number | null }> {
  const payload = await telegramMethod<TelegramSendMessageResult>(
    token,
    "sendMessage",
    {
      chat_id: chatId,
      text: String(text ?? "").trim() || "Done.",
      disable_web_page_preview: true,
    },
    profiler,
  );
  return { messageId: payload.result?.message_id ?? null };
}

export async function sendTelegramTypingAction(
  token: string,
  chatId: number,
  profiler?: Profiler,
): Promise<void> {
  await telegramMethod(
    token,
    "sendChatAction",
    {
      chat_id: chatId,
      action: "typing",
    },
    profiler,
  );
}

export async function streamTelegramReply(params: {
  token: string;
  chatId: number;
  textStream: AsyncIterable<string>;
  updateIntervalMs?: number;
  profiler?: Profiler;
}): Promise<{ text: string }> {
  const updateIntervalMs = Math.max(
    0,
    params.updateIntervalMs ?? TELEGRAM_DEFAULT_STREAM_UPDATE_INTERVAL_MS,
  );
  const iterator = params.textStream[Symbol.asyncIterator]();
  const draftId = createDraftId();
  let accumulated = "";
  let lastSentText = "";
  let lastSentAt = 0;
  let draftUpdatesSent = 0;
  let fallbackMessageId: number | null = null;
  let usingDrafts = true;

  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    if (!accumulated) params.profiler?.event("first_token_received");
    accumulated += next.value;
    const trimmed = accumulated.trim();
    if (!trimmed) continue;

    const now = Date.now();
    const intervalElapsed = draftUpdatesSent === 0 || now - lastSentAt >= updateIntervalMs;
    if (!intervalElapsed) continue;
    if (trimmed === lastSentText) continue;

    if (usingDrafts) {
      try {
        await telegramMethod(
          params.token,
          "sendMessageDraft",
          {
            chat_id: params.chatId,
            draft_id: draftId,
            text: trimmed,
          },
          params.profiler,
        );
        if (draftUpdatesSent === 0)
          params.profiler?.event("first_telegram_update_sent", { mode: "draft" });
        lastSentText = trimmed;
        lastSentAt = now;
        draftUpdatesSent += 1;
        continue;
      } catch (error) {
        if (!isUnsupportedDraftMethod(error)) throw error;
        usingDrafts = false;
      }
    }

    if (fallbackMessageId === null) {
      const sent = await sendTelegramTextMessage(
        params.token,
        params.chatId,
        trimmed,
        params.profiler,
      );
      if (draftUpdatesSent === 0)
        params.profiler?.event("first_telegram_update_sent", { mode: "send" });
      fallbackMessageId = sent.messageId;
    } else {
      await telegramMethod(
        params.token,
        "editMessageText",
        {
          chat_id: params.chatId,
          message_id: fallbackMessageId,
          text: trimmed,
          disable_web_page_preview: true,
        },
        params.profiler,
      );
    }
    lastSentText = trimmed;
    lastSentAt = now;
    draftUpdatesSent += 1;
  }

  const finalText = accumulated.trim();
  if (!finalText) throw new Error("Telegram stream reply was empty");

  if (usingDrafts) {
    await sendTelegramTextMessage(params.token, params.chatId, finalText, params.profiler);
  } else if (fallbackMessageId !== null && finalText !== lastSentText) {
    await telegramMethod(
      params.token,
      "editMessageText",
      {
        chat_id: params.chatId,
        message_id: fallbackMessageId,
        text: finalText,
        disable_web_page_preview: true,
      },
      params.profiler,
    );
  }

  return { text: finalText };
}

export async function fetchTelegramImageAsDataUrl(
  token: string,
  fileId: string,
): Promise<string | null> {
  const getFileResponse = await fetch(
    `${TELEGRAM_API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!getFileResponse.ok) return null;

  const fileJson = (await getFileResponse.json()) as { result?: { file_path?: string } };
  const filePath = fileJson.result?.file_path;
  if (!filePath) return null;

  const imageResponse = await fetch(`${TELEGRAM_API}/file/bot${token}/${filePath}`);
  if (!imageResponse.ok) return null;

  const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function telegramMethod<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  profiler?: Profiler,
): Promise<T> {
  const response = await (profiler?.span(`telegram_${method}`, async () =>
    fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  ) ??
    fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  const payloadText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram ${method} failed (${response.status}): ${payloadText}`);
  }
  if (!payloadText) return {} as T;
  return JSON.parse(payloadText) as T;
}

function createDraftId(): number {
  const random = globalThis.crypto?.getRandomValues?.(new Uint32Array(1))?.[0] ?? Date.now();
  return Math.max(1, random >>> 0);
}

function isUnsupportedDraftMethod(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : "";
  return (
    message.includes("sendmessagedraft") &&
    (message.includes("404") ||
      message.includes("method not found") ||
      message.includes("unknown method") ||
      message.includes("not available"))
  );
}
