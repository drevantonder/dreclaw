import { decodeEncryptionKey, encryptSecret } from "./crypto";
import {
  getGoogleOAuthState,
  markGoogleOAuthStateUsed,
  markUpdateSeen,
  upsertGoogleOAuthToken,
} from "./db";
import { createBot, maybeHandleAsyncTelegramCommand } from "./bot";
import { ConversationWorkflow } from "./conversation-workflow";
import { ExecuteHost } from "./execute-host";
import { exchangeGoogleOAuthCode, getGoogleOAuthConfig } from "./google-oauth";
import { sendTelegramTextMessage } from "./telegram-api";
import type { Env, TelegramUpdate } from "./types";

const GOOGLE_OAUTH_DEFAULT_PRINCIPAL = "default";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "dreclaw", ts: Date.now() });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const update = (await request
        .clone()
        .json()
        .catch(() => null)) as TelegramUpdate | null;
      const firstSeen = update?.update_id
        ? await markUpdateSeen(env.DRECLAW_DB, update.update_id)
        : true;
      if (!firstSeen) return new Response("ok");
      if (
        update &&
        (await maybeHandleAsyncTelegramCommand(env, update, (task) => ctx.waitUntil(task), ctx))
      ) {
        return new Response("ok");
      }
      const bot = createBot(env, ctx);
      return bot.webhooks.telegram(request, {
        waitUntil: (task) => ctx.waitUntil(task),
      });
    }

    if (request.method === "GET" && url.pathname === "/google/oauth/callback") {
      return handleGoogleOAuthCallback(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
  async queue(): Promise<void> {
    return;
  },
} satisfies ExportedHandler<Env>;

export { ConversationWorkflow };
export { ExecuteHost };

async function handleGoogleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") ?? "").trim();
  const code = String(url.searchParams.get("code") ?? "").trim();
  if (!state || !code) {
    return htmlResponse(400, "Google OAuth failed", "Missing state or code.");
  }

  const oauthState = await getGoogleOAuthState(env.DRECLAW_DB, state);
  if (!oauthState) return htmlResponse(400, "Google OAuth failed", "Invalid or expired state.");
  if (oauthState.usedAt)
    return htmlResponse(400, "Google OAuth failed", "This authorization link was already used.");
  if (Date.parse(oauthState.expiresAt) <= Date.now()) {
    return htmlResponse(
      400,
      "Google OAuth failed",
      "Authorization link expired. Run /google connect again.",
    );
  }

  const marked = await markGoogleOAuthStateUsed(env.DRECLAW_DB, state, new Date().toISOString());
  if (!marked)
    return htmlResponse(400, "Google OAuth failed", "Authorization link is no longer valid.");

  try {
    const oauthConfig = getGoogleOAuthConfig(env);
    const exchange = await exchangeGoogleOAuthCode(oauthConfig, code);
    if (!exchange.refreshToken) {
      throw new Error(
        "Google did not return a refresh token. Revoke app access and retry /google connect.",
      );
    }

    const encrypted = await encryptSecret(
      exchange.refreshToken,
      decodeEncryptionKey(String(env.GOOGLE_OAUTH_ENCRYPTION_KEY ?? "")),
    );
    await upsertGoogleOAuthToken(env.DRECLAW_DB, {
      principal: GOOGLE_OAUTH_DEFAULT_PRINCIPAL,
      telegramUserId: oauthState.telegramUserId,
      refreshTokenCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      scopes: exchange.scope,
      updatedAt: new Date().toISOString(),
    });

    try {
      await sendTelegramTextMessage(
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

    return htmlResponse(
      200,
      "Google OAuth complete",
      "You can close this tab and return to Telegram.",
    );
  } catch (error) {
    return htmlResponse(
      400,
      "Google OAuth failed",
      error instanceof Error ? error.message : "Unknown OAuth error",
    );
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
