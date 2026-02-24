import { markUpdateSeen } from "./db";
import { SessionRuntime } from "./session";
import { sendTelegramChatAction, sendTelegramMessage } from "./telegram";
import { processTelegramUpdate } from "./telegram-update-processor";
import type { Env } from "./types";

export { SessionRuntime };

const WEBHOOK_MAX_BODY_BYTES = 256_000;

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "dreclaw", ts: Date.now() });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return new Response("Unsupported media type", { status: 415 });
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > WEBHOOK_MAX_BODY_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }
  }

  const rawBody = await request.text();
  if (rawBody.length > WEBHOOK_MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const result = await processTelegramUpdate(
    {
      body,
      allowedUserId: env.TELEGRAM_ALLOWED_USER_ID,
    },
    {
      markUpdateSeen: (updateId) => markUpdateSeen(env.DRECLAW_DB, updateId),
      sendTyping: (chatId) => sendTelegramChatAction(env.TELEGRAM_BOT_TOKEN, chatId),
      runSession: async (sessionRequest) => {
        const id = env.SESSION_RUNTIME.idFromName(String(sessionRequest.message.chat.id));
        const stub = env.SESSION_RUNTIME.get(id);
        const response = await stub.fetch("https://session.local/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sessionRequest),
        });
        return (await response.json()) as { ok: boolean; text: string };
      },
    },
  );

  if (result.status === "reply") {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, result.reply.chatId, result.reply.text);
  }

  return new Response("ok");
}

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maxLength; index += 1) {
    const leftByte = index < leftBytes.length ? leftBytes[index] : 0;
    const rightByte = index < rightBytes.length ? rightBytes[index] : 0;
    diff |= leftByte ^ rightByte;
  }

  return diff === 0;
}
