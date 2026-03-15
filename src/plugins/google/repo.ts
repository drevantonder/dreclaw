import { retryOnce } from "../../utils/retry";

export interface GoogleOAuthStateRecord {
  state: string;
  chatId: number;
  telegramUserId: number;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface GoogleOAuthTokenRecord {
  principal: string;
  telegramUserId: number | null;
  refreshTokenCiphertext: string;
  nonce: string;
  scopes: string;
  updatedAt: string;
}

export async function createGoogleOAuthState(
  db: D1Database,
  state: Omit<GoogleOAuthStateRecord, "usedAt">,
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO google_oauth_states (state, chat_id, telegram_user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      )
      .bind(state.state, state.chatId, state.telegramUserId, state.expiresAt, state.createdAt)
      .run();
  }, 150);
}

export async function getGoogleOAuthState(
  db: D1Database,
  state: string,
): Promise<GoogleOAuthStateRecord | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT state, chat_id, telegram_user_id, expires_at, used_at, created_at FROM google_oauth_states WHERE state = ?",
      )
      .bind(state)
      .first<Record<string, unknown>>();
    return row ? mapGoogleOAuthStateRecord(row) : null;
  }, 150);
}

export async function markGoogleOAuthStateUsed(
  db: D1Database,
  state: string,
  usedAt: string,
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("UPDATE google_oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL")
      .bind(usedAt, state)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function upsertGoogleOAuthToken(
  db: D1Database,
  token: GoogleOAuthTokenRecord,
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO google_oauth_tokens (principal, telegram_user_id, refresh_token_ciphertext, nonce, scopes, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(principal) DO UPDATE SET telegram_user_id = excluded.telegram_user_id, refresh_token_ciphertext = excluded.refresh_token_ciphertext, nonce = excluded.nonce, scopes = excluded.scopes, updated_at = excluded.updated_at",
      )
      .bind(
        token.principal,
        token.telegramUserId,
        token.refreshTokenCiphertext,
        token.nonce,
        token.scopes,
        token.updatedAt,
      )
      .run();
  }, 150);
}

export async function getGoogleOAuthToken(
  db: D1Database,
  principal: string,
): Promise<GoogleOAuthTokenRecord | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT principal, telegram_user_id, refresh_token_ciphertext, nonce, scopes, updated_at FROM google_oauth_tokens WHERE principal = ?",
      )
      .bind(principal)
      .first<Record<string, unknown>>();
    return row ? mapGoogleOAuthTokenRecord(row) : null;
  }, 150);
}

export async function deleteGoogleOAuthToken(db: D1Database, principal: string): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("DELETE FROM google_oauth_tokens WHERE principal = ?")
      .bind(principal)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

function mapGoogleOAuthStateRecord(row: Record<string, unknown>): GoogleOAuthStateRecord {
  return {
    state: stringFromUnknown(row.state),
    chatId: Number(row.chat_id ?? 0),
    telegramUserId: Number(row.telegram_user_id ?? 0),
    expiresAt: stringFromUnknown(row.expires_at),
    usedAt:
      row.used_at === null || row.used_at === undefined ? null : stringFromUnknown(row.used_at),
    createdAt: stringFromUnknown(row.created_at),
  };
}

function mapGoogleOAuthTokenRecord(row: Record<string, unknown>): GoogleOAuthTokenRecord {
  const telegramUserId = row.telegram_user_id;
  return {
    principal: stringFromUnknown(row.principal),
    telegramUserId:
      telegramUserId === null || telegramUserId === undefined ? null : Number(telegramUserId),
    refreshTokenCiphertext: stringFromUnknown(row.refresh_token_ciphertext),
    nonce: stringFromUnknown(row.nonce),
    scopes: stringFromUnknown(row.scopes),
    updatedAt: stringFromUnknown(row.updated_at),
  };
}

function stringFromUnknown(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? `${value}`
      : "";
}
