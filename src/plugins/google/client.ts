import { decodeEncryptionKey, decryptSecret } from "./crypto";
import { GOOGLE_OAUTH_DEFAULT_PRINCIPAL, getGoogleOAuthConfig } from "./config";
import { refreshGoogleAccessToken } from "./oauth";
import { getGoogleOAuthToken } from "./repo";
import type { GooglePluginDeps } from "./types";

export async function getGoogleAccessToken(
  deps: GooglePluginDeps,
  timeoutMs: number,
): Promise<{ accessToken: string; scope: string }> {
  const token = await getGoogleOAuthToken(deps.db, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
  if (!token) throw new Error("Google account not linked. Run /google connect");
  const refreshToken = await decryptSecret(
    { ciphertext: token.refreshTokenCiphertext, nonce: token.nonce },
    decodeEncryptionKey(String(deps.settings.encryptionKey ?? "")),
  );
  const refreshed = await refreshGoogleAccessToken(
    getGoogleOAuthConfig(deps.settings),
    refreshToken,
    timeoutMs,
  );
  return { accessToken: refreshed.accessToken, scope: refreshed.scope };
}

export async function isGoogleLinked(deps: GooglePluginDeps): Promise<boolean> {
  return Boolean(await getGoogleOAuthToken(deps.db, GOOGLE_OAUTH_DEFAULT_PRINCIPAL));
}
