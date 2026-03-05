import { getGoogleOAuthState, markGoogleOAuthStateUsed, markUpdateSeen, upsertGoogleOAuthToken } from "./db";
import { decodeEncryptionKey, encryptSecret } from "./crypto";
import { exchangeGoogleOAuthCode, getGoogleOAuthConfig } from "./google-oauth";
import { SessionRuntime } from "./session";
import { sendTelegramChatAction, sendTelegramMessage } from "./telegram";
import { processTelegramUpdate } from "./telegram-update-processor";
import type { Env } from "./types";

export { SessionRuntime };

const WEBHOOK_MAX_BODY_BYTES = 256_000;
const GOOGLE_OAUTH_DEFAULT_PRINCIPAL = "default";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "dreclaw", ts: Date.now() });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/google/oauth/callback") {
      return handleGoogleOAuthCallback(request, env);
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

async function handleGoogleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") ?? "").trim();
  const code = String(url.searchParams.get("code") ?? "").trim();
  if (!state || !code) {
    return htmlResponse(400, "Google OAuth failed", "Missing state or code.");
  }

  const oauthState = await getGoogleOAuthState(env.DRECLAW_DB, state);
  if (!oauthState) {
    return htmlResponse(400, "Google OAuth failed", "Invalid or expired state.");
  }
  if (oauthState.usedAt) {
    return htmlResponse(400, "Google OAuth failed", "This authorization link was already used.");
  }
  if (Date.parse(oauthState.expiresAt) <= Date.now()) {
    return htmlResponse(400, "Google OAuth failed", "Authorization link expired. Run /google connect again.");
  }

  const markedUsed = await markGoogleOAuthStateUsed(env.DRECLAW_DB, state, new Date().toISOString());
  if (!markedUsed) {
    return htmlResponse(400, "Google OAuth failed", "Authorization link is no longer valid.");
  }

  try {
    const oauthConfig = getGoogleOAuthConfig(env);
    const exchange = await exchangeGoogleOAuthCode(oauthConfig, code);
    const refreshToken = exchange.refreshToken;
    if (!refreshToken) {
      throw new Error("Google did not return a refresh token. Revoke app access and retry /google connect.");
    }

    const key = decodeEncryptionKey(String(env.GOOGLE_OAUTH_ENCRYPTION_KEY ?? ""));
    const encrypted = await encryptSecret(refreshToken, key);
    await upsertGoogleOAuthToken(env.DRECLAW_DB, {
      principal: GOOGLE_OAUTH_DEFAULT_PRINCIPAL,
      telegramUserId: oauthState.telegramUserId,
      refreshTokenCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      scopes: exchange.scope,
      updatedAt: new Date().toISOString(),
    });

    try {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        oauthState.chatId,
        "Google account linked successfully. You can now use Google features.",
      );
    } catch (error) {
      console.warn("google-oauth-telegram-notify-failed", {
        chatId: oauthState.chatId,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }

    return htmlResponse(200, "Google OAuth complete", "You can close this tab and return to Telegram.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OAuth error";
    return htmlResponse(400, "Google OAuth failed", message);
  }
}

function htmlResponse(status: number, title: string, message: string): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
