export interface OAuthCredential {
  provider: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
}

export type CredentialMap = Record<string, OAuthCredential>;

export async function getOAuthApiKey(
  provider: string,
  credentialsMap: CredentialMap,
): Promise<{ apiKey: string; updated?: OAuthCredential }> {
  const credential = credentialsMap[provider];
  if (!credential?.accessToken) {
    throw new Error(`Missing OAuth credential for provider: ${provider}`);
  }

  if (!isExpired(credential)) {
    return { apiKey: credential.accessToken };
  }

  if (!credential.refreshToken || !credential.clientId || !credential.tokenEndpoint) {
    return { apiKey: credential.accessToken };
  }

  const refreshed = await refreshCredential(credential);
  return { apiKey: refreshed.accessToken, updated: refreshed };
}

export function normalizeImportedCredential(raw: unknown): OAuthCredential {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid credential payload");
  }

  const value = raw as Record<string, unknown>;
  const provider = String(value.provider ?? "openai-codex").trim();
  const accessToken = String(value.accessToken ?? value.access_token ?? "").trim();

  if (!provider) throw new Error("provider is required");
  if (!accessToken) throw new Error("accessToken is required");

  return {
    provider,
    accessToken,
    refreshToken: toOptionalString(value.refreshToken ?? value.refresh_token),
    expiresAt: normalizeExpiry(value.expiresAt, value.expires_in),
    tokenEndpoint: toOptionalString(value.tokenEndpoint),
    clientId: toOptionalString(value.clientId),
    clientSecret: toOptionalString(value.clientSecret),
  };
}

function toOptionalString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function normalizeExpiry(expiresAt: unknown, expiresIn: unknown): string | undefined {
  const explicit = toOptionalString(expiresAt);
  if (explicit) return explicit;

  const seconds = Number(expiresIn ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isExpired(credential: OAuthCredential): boolean {
  if (!credential.expiresAt) return false;
  const expires = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires <= Date.now() + 60_000;
}

async function refreshCredential(credential: OAuthCredential): Promise<OAuthCredential> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", credential.refreshToken as string);
  body.set("client_id", credential.clientId as string);
  if (credential.clientSecret) body.set("client_secret", credential.clientSecret);

  const response = await fetch(credential.tokenEndpoint as string, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`OAuth refresh failed: ${JSON.stringify(payload)}`);
  }

  const refreshed: OAuthCredential = {
    ...credential,
    accessToken: String(payload.access_token ?? "").trim(),
    refreshToken: String(payload.refresh_token ?? credential.refreshToken ?? "").trim() || credential.refreshToken,
    expiresAt: normalizeExpiry(payload.expires_at, payload.expires_in),
  };

  if (!refreshed.accessToken) {
    throw new Error("OAuth refresh response missing access token");
  }
  return refreshed;
}
