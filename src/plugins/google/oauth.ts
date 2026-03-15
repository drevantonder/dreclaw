import type { GoogleOAuthConfig } from "./config";

const GOOGLE_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

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
    throw new Error(
      `Google OAuth token exchange failed: ${stringFromUnknown(payload.error_description) || stringFromUnknown(payload.error) || "token exchange failed"}`,
    );
  }
  const accessToken = stringFromUnknown(payload.access_token);
  if (!accessToken) throw new Error("Google OAuth token exchange failed: missing access token");
  return {
    accessToken,
    refreshToken: stringFromUnknown(payload.refresh_token) || null,
    scope: stringFromUnknown(payload.scope),
    expiresIn: Number(payload.expires_in ?? 0),
    tokenType: stringFromUnknown(payload.token_type) || "Bearer",
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
    throw new Error(
      `Google OAuth token refresh failed: ${stringFromUnknown(payload.error_description) || stringFromUnknown(payload.error) || "token refresh failed"}`,
    );
  }
  const accessToken = stringFromUnknown(payload.access_token);
  if (!accessToken) throw new Error("Google OAuth token refresh failed: missing access token");
  return {
    accessToken,
    scope: stringFromUnknown(payload.scope),
    expiresIn: Number(payload.expires_in ?? 0),
    tokenType: stringFromUnknown(payload.token_type) || "Bearer",
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
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

function stringFromUnknown(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? `${value}`
      : "";
}
