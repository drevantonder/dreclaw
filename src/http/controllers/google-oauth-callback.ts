import { decodeEncryptionKey, encryptSecret } from "../../crypto";
import { getGoogleOAuthState, markGoogleOAuthStateUsed, upsertGoogleOAuthToken } from "../../db";
import { exchangeGoogleOAuthCode, getGoogleOAuthConfig } from "../../google-oauth";
import { sendTelegramTextMessage } from "../../telegram-api";
import type { Env } from "../../types";
import { htmlResponse } from "../response";

const GOOGLE_OAUTH_DEFAULT_PRINCIPAL = "default";

export async function handleGoogleOAuthCallbackRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") ?? "").trim();
  const code = String(url.searchParams.get("code") ?? "").trim();
  if (!state || !code) {
    return htmlResponse(400, "Google OAuth failed", "Missing state or code.");
  }

  const oauthState = await getGoogleOAuthState(env.DRECLAW_DB, state);
  if (!oauthState) return htmlResponse(400, "Google OAuth failed", "Invalid or expired state.");
  if (oauthState.usedAt) {
    return htmlResponse(400, "Google OAuth failed", "This authorization link was already used.");
  }
  if (Date.parse(oauthState.expiresAt) <= Date.now()) {
    return htmlResponse(
      400,
      "Google OAuth failed",
      "Authorization link expired. Run /google connect again.",
    );
  }

  const marked = await markGoogleOAuthStateUsed(env.DRECLAW_DB, state, new Date().toISOString());
  if (!marked) {
    return htmlResponse(400, "Google OAuth failed", "Authorization link is no longer valid.");
  }

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
        error:
          error instanceof Error ? error.message : typeof error === "string" ? error : "unknown",
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
