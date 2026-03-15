import type { Env } from "../../cloudflare/env";
import { handleGoogleOAuthCallback as handleGoogleOAuthCallbackImpl } from "./callback";
import {
  handleGoogleCommand as handleGoogleCommandImpl,
  isBusySensitiveGoogleCommand,
  isGoogleCommandText,
} from "./commands";
import {
  getGoogleOAuthConfig as getGoogleOAuthConfigImpl,
  parseGoogleScopes,
  GOOGLE_OAUTH_DEFAULT_PRINCIPAL,
} from "./config";
import { decodeEncryptionKey, decryptSecret, encryptSecret } from "./crypto";
import {
  buildGoogleOAuthUrl,
  createOAuthStateToken,
  exchangeGoogleOAuthCode,
  refreshGoogleAccessToken,
} from "./oauth";
import {
  createGoogleOAuthState,
  deleteGoogleOAuthToken,
  getGoogleOAuthState,
  getGoogleOAuthToken,
  markGoogleOAuthStateUsed,
  upsertGoogleOAuthToken,
} from "./repo";
import type { GooglePluginDeps } from "./types";

export {
  buildGoogleOAuthUrl,
  createOAuthStateToken,
  exchangeGoogleOAuthCode,
  refreshGoogleAccessToken,
  parseGoogleScopes,
  GOOGLE_OAUTH_DEFAULT_PRINCIPAL,
  decodeEncryptionKey,
  decryptSecret,
  encryptSecret,
  createGoogleOAuthState,
  deleteGoogleOAuthToken,
  getGoogleOAuthState,
  getGoogleOAuthToken,
  markGoogleOAuthStateUsed,
  upsertGoogleOAuthToken,
  isBusySensitiveGoogleCommand,
  isGoogleCommandText,
};

export function getGoogleOAuthConfig(env: Env) {
  return getGoogleOAuthConfigImpl(normalizeDeps(env).settings);
}

export async function handleGoogleCommand(
  env: Env,
  input: { text: string; chatId: number; telegramUserId: number },
) {
  const result = await handleGoogleCommandImpl(normalizeDeps(env), {
    threadId: `telegram:${input.chatId}`,
    channelId: input.chatId,
    actorId: String(input.telegramUserId),
    replyTarget: { channel: "telegram", id: String(input.chatId) },
    text: input.text,
  });
  return result.messages.join("\n");
}

export async function handleGoogleOAuthCallback(request: Request, env: Env) {
  return handleGoogleOAuthCallbackImpl(request, normalizeDeps(env));
}

function normalizeDeps(env: Env): GooglePluginDeps {
  return {
    db: env.DRECLAW_DB,
    settings: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
      scopes: env.GOOGLE_OAUTH_SCOPES,
      encryptionKey: env.GOOGLE_OAUTH_ENCRYPTION_KEY,
    },
  };
}
