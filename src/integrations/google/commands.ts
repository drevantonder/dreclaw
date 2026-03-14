import type { Env } from "../../types";
import { GOOGLE_OAUTH_DEFAULT_PRINCIPAL, getGoogleOAuthConfig } from "./config";
import { buildGoogleOAuthUrl, createOAuthStateToken } from "./oauth";
import { createGoogleOAuthState, deleteGoogleOAuthToken, getGoogleOAuthToken } from "./repo";

export async function handleGoogleCommand(
  env: Env,
  input: { text: string; chatId: number; telegramUserId: number },
): Promise<string> {
  const parts = input.text
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const action = parts[1]?.toLowerCase() ?? "";
  if (!action || action === "help") {
    return [
      "Google OAuth commands:",
      "/google connect - link your Google account",
      "/google status - show link status and scopes",
      "/google disconnect - remove saved token",
    ].join("\n");
  }

  if (action === "connect") {
    const config = getGoogleOAuthConfig(env);
    const state = createOAuthStateToken();
    const nowIso = new Date().toISOString();
    await createGoogleOAuthState(env.DRECLAW_DB, {
      state,
      chatId: input.chatId,
      telegramUserId: input.telegramUserId,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      createdAt: nowIso,
    });
    return [
      "Open this URL to connect Google:",
      buildGoogleOAuthUrl(config, state),
      "This link expires in 10 minutes.",
    ].join("\n");
  }

  if (action === "status") {
    const token = await getGoogleOAuthToken(env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
    if (!token) return "google: not linked\nrun: /google connect";
    return [
      "google: linked",
      `scopes: ${token.scopes || "unknown"}`,
      `updated_at: ${token.updatedAt}`,
    ].join("\n");
  }

  if (action === "disconnect") {
    const deleted = await deleteGoogleOAuthToken(env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
    return deleted ? "Google account disconnected." : "No linked Google account found.";
  }

  return "Unknown /google command. Use /google help";
}
