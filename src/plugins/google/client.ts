import type { Env } from "../../cloudflare/env";
import { decodeEncryptionKey, decryptSecret } from "./crypto";
import { GOOGLE_OAUTH_DEFAULT_PRINCIPAL, getGoogleOAuthConfig } from "./config";
import { refreshGoogleAccessToken } from "./oauth";
import { getGoogleOAuthToken } from "./repo";

export async function getGoogleAccessToken(
  env: Env,
  timeoutMs: number,
): Promise<{ accessToken: string; scope: string }> {
  const token = await getGoogleOAuthToken(env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
  if (!token) throw new Error("Google account not linked. Run /google connect");
  const refreshToken = await decryptSecret(
    { ciphertext: token.refreshTokenCiphertext, nonce: token.nonce },
    decodeEncryptionKey(String(env.GOOGLE_OAUTH_ENCRYPTION_KEY ?? "")),
  );
  const refreshed = await refreshGoogleAccessToken(
    getGoogleOAuthConfig(env),
    refreshToken,
    timeoutMs,
  );
  return { accessToken: refreshed.accessToken, scope: refreshed.scope };
}

export async function isGoogleLinked(env: Env): Promise<boolean> {
  return Boolean(await getGoogleOAuthToken(env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL));
}
