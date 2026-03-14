import type { Env } from "../types";

const DEFAULT_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
];

export const GOOGLE_OAUTH_DEFAULT_PRINCIPAL = "default";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export function getGoogleOAuthConfig(env: Env): GoogleOAuthConfig {
  const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const redirectUri = String(env.GOOGLE_OAUTH_REDIRECT_URI ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth is not configured");
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes: parseGoogleScopes(env.GOOGLE_OAUTH_SCOPES),
  };
}

export function parseGoogleScopes(raw: string | undefined): string[] {
  const normalized = String(raw ?? "").trim();
  const source = normalized ? normalized.split(/\s+/) : DEFAULT_SCOPES;
  const uniq = new Set<string>();
  for (const item of source) {
    const scope = item.trim();
    if (!scope) continue;
    uniq.add(scope);
  }
  if (!uniq.size) throw new Error("GOOGLE_OAUTH_SCOPES cannot be empty");
  return [...uniq];
}
