import type { CommandContext, CommandResult } from "../../core/app/types";
import { GOOGLE_OAUTH_DEFAULT_PRINCIPAL, getGoogleOAuthConfig } from "./config";
import { buildGoogleOAuthUrl, createOAuthStateToken } from "./oauth";
import { createGoogleOAuthState, deleteGoogleOAuthToken, getGoogleOAuthToken } from "./repo";
import type { GooglePluginDeps } from "./types";

export function isGoogleCommandText(text: string): boolean {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .startsWith("/google");
}

export function isBusySensitiveGoogleCommand(text: string): boolean {
  const action = parseGoogleAction(text);
  return action === "connect" || action === "disconnect";
}

export async function handleGoogleCommand(
  deps: GooglePluginDeps,
  input: CommandContext,
): Promise<CommandResult> {
  const action = parseGoogleAction(input.text);
  if (!action || action === "help") {
    return {
      messages: [
        [
          "Google OAuth commands:",
          "/google connect - link your Google account",
          "/google status - show link status and scopes",
          "/google disconnect - remove saved token",
        ].join("\n"),
      ],
    };
  }

  if (action === "connect") {
    const config = getGoogleOAuthConfig(deps.settings);
    const state = createOAuthStateToken();
    const nowIso = new Date().toISOString();
    await createGoogleOAuthState(deps.db, {
      state,
      chatId: input.channelId,
      telegramUserId: Number(input.actorId || 0),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      createdAt: nowIso,
    });
    return {
      messages: [
        [
          "Open this URL to connect Google:",
          buildGoogleOAuthUrl(config, state),
          "This link expires in 10 minutes.",
        ].join("\n"),
      ],
    };
  }

  if (action === "status") {
    const token = await getGoogleOAuthToken(deps.db, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
    if (!token) return { messages: ["google: not linked\nrun: /google connect"] };
    return {
      messages: [
        [
          "google: linked",
          `scopes: ${token.scopes || "unknown"}`,
          `updated_at: ${token.updatedAt}`,
        ].join("\n"),
      ],
    };
  }

  if (action === "disconnect") {
    const deleted = await deleteGoogleOAuthToken(deps.db, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
    return {
      messages: [deleted ? "Google account disconnected." : "No linked Google account found."],
    };
  }

  return { messages: ["Unknown /google command. Use /google help"] };
}

function parseGoogleAction(text: string): string {
  const parts = text
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts[1]?.toLowerCase() ?? "";
}
