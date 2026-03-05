import type { Env } from "./types";

const GOOGLE_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface GoogleTokenExchangeResult {
  accessToken: string;
  refreshToken: string | null;
  scope: string;
  expiresIn: number;
  tokenType: string;
}

export interface GoogleTokenRefreshResult {
  accessToken: string;
  scope: string;
  expiresIn: number;
  tokenType: string;
}

export function getGoogleOAuthConfig(env: Env): GoogleOAuthConfig {
  const clientId = String(env.GOOGLE_OAUTH_CLIENT_ID ?? "").trim();
  const clientSecret = String(env.GOOGLE_OAUTH_CLIENT_SECRET ?? "").trim();
  const redirectUri = String(env.GOOGLE_OAUTH_REDIRECT_URI ?? "").trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth is not configured");
  }

  const scopes = parseGoogleScopes(env.GOOGLE_OAUTH_SCOPES);
  return {
    clientId,
    clientSecret,
    redirectUri,
    scopes,
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
  if (!uniq.size) {
    throw new Error("GOOGLE_OAUTH_SCOPES cannot be empty");
  }
  return [...uniq];
}

export function buildGoogleOAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: config.scopes.join(" "),
    state,
  });
  return `${GOOGLE_AUTH_BASE_URL}?${params.toString()}`;
}

export function createOAuthStateToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export async function exchangeGoogleOAuthCode(
  config: GoogleOAuthConfig,
  code: string,
  timeoutMs = 10_000,
): Promise<GoogleTokenExchangeResult> {
  const params = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetchWithTimeout(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    timeoutMs,
  );

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const description = String(payload.error_description ?? payload.error ?? "token exchange failed");
    throw new Error(`Google OAuth token exchange failed: ${description}`);
  }

  const accessToken = String(payload.access_token ?? "");
  if (!accessToken) {
    throw new Error("Google OAuth token exchange failed: missing access token");
  }

  return {
    accessToken,
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : null,
    scope: String(payload.scope ?? ""),
    expiresIn: Number(payload.expires_in ?? 0),
    tokenType: String(payload.token_type ?? "Bearer"),
  };
}

export async function refreshGoogleAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
  timeoutMs = 10_000,
): Promise<GoogleTokenRefreshResult> {
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetchWithTimeout(
    GOOGLE_TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    },
    timeoutMs,
  );

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const description = String(payload.error_description ?? payload.error ?? "token refresh failed");
    throw new Error(`Google OAuth token refresh failed: ${description}`);
  }

  const accessToken = String(payload.access_token ?? "");
  if (!accessToken) {
    throw new Error("Google OAuth token refresh failed: missing access token");
  }

  return {
    accessToken,
    scope: String(payload.scope ?? ""),
    expiresIn: Number(payload.expires_in ?? 0),
    tokenType: String(payload.token_type ?? "Bearer"),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetchPromise = fetch(url, { ...init, signal: controller.signal });
    const timeoutPromise = new Promise<Response>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Google OAuth request timed out"));
      }, timeoutMs);
    });
    return await Promise.race([fetchPromise, timeoutPromise]);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Google OAuth request timed out");
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
