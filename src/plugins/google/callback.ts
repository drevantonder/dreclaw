import type { Env } from "../../cloudflare/env";
import { decodeEncryptionKey, encryptSecret } from "../../integrations/google/crypto";
import {
  GOOGLE_OAUTH_DEFAULT_PRINCIPAL,
  getGoogleOAuthConfig,
} from "../../integrations/google/config";
import { exchangeGoogleOAuthCode } from "../../integrations/google/oauth";
import {
  getGoogleOAuthState,
  markGoogleOAuthStateUsed,
  upsertGoogleOAuthToken,
} from "../../integrations/google/repo";
import type { OAuthCallbackResult } from "../../core/plugins/types";

export async function handleGoogleOAuthCallback(
  request: Request,
  env: Env,
): Promise<OAuthCallbackResult> {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") ?? "").trim();
  const code = String(url.searchParams.get("code") ?? "").trim();
  if (!state || !code) {
    return failure(400, "Google OAuth failed", "Missing state or code.");
  }

  const oauthState = await getGoogleOAuthState(env.DRECLAW_DB, state);
  if (!oauthState) return failure(400, "Google OAuth failed", "Invalid or expired state.");
  if (oauthState.usedAt) {
    return failure(400, "Google OAuth failed", "This authorization link was already used.");
  }
  if (Date.parse(oauthState.expiresAt) <= Date.now()) {
    return failure(
      400,
      "Google OAuth failed",
      "Authorization link expired. Run /google connect again.",
    );
  }

  const marked = await markGoogleOAuthStateUsed(env.DRECLAW_DB, state, new Date().toISOString());
  if (!marked) {
    return failure(400, "Google OAuth failed", "Authorization link is no longer valid.");
  }

  try {
    const exchange = await exchangeGoogleOAuthCode(getGoogleOAuthConfig(env), code);
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

    return {
      status: 200,
      title: "Google OAuth complete",
      body: "You can close this tab and return to Telegram.",
      notifyTelegram: {
        chatId: oauthState.chatId,
        text: "Google account linked successfully. You can now use Google features.",
      },
    };
  } catch (error) {
    return failure(
      400,
      "Google OAuth failed",
      error instanceof Error ? error.message : "Unknown OAuth error",
    );
  }
}

function failure(status: number, title: string, body: string): OAuthCallbackResult {
  return { status, title, body };
}
