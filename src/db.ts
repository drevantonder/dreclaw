import type { OAuthCredential } from "./oauth";

export async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return fn();
  }
}

export async function getCredentialMap(db: D1Database): Promise<Record<string, OAuthCredential>> {
  return runWithRetry(async () => {
    const result = await db
      .prepare("SELECT provider, payload FROM oauth_credentials")
      .all<{ provider: string; payload: string }>();

    const map: Record<string, OAuthCredential> = {};
    for (const row of result.results ?? []) {
      try {
        map[row.provider] = JSON.parse(row.payload) as OAuthCredential;
      } catch {
        continue;
      }
    }
    return map;
  });
}

export async function upsertCredential(db: D1Database, credential: OAuthCredential): Promise<void> {
  await runWithRetry(async () => {
    await db
      .prepare(
        "INSERT INTO oauth_credentials (provider, payload, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at",
      )
      .bind(credential.provider, JSON.stringify(credential), new Date().toISOString())
      .run();
  });
}

export async function markUpdateSeen(db: D1Database, updateId: number): Promise<boolean> {
  return runWithRetry(async () => {
    const result = await db
      .prepare("INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?)")
      .bind(updateId, new Date().toISOString())
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  });
}

export async function upsertSessionMeta(
  db: D1Database,
  sessionId: string,
  chatId: number,
  model: string,
  authReady: boolean,
): Promise<void> {
  await runWithRetry(async () => {
    await db
      .prepare(
        "INSERT INTO sessions (session_id, chat_id, model, auth_ready, last_seen_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(session_id) DO UPDATE SET model=excluded.model, auth_ready=excluded.auth_ready, last_seen_at=excluded.last_seen_at",
      )
      .bind(sessionId, String(chatId), model, authReady ? 1 : 0, new Date().toISOString())
      .run();
  });
}

export async function startRun(db: D1Database, runId: string, sessionId: string): Promise<void> {
  await runWithRetry(async () => {
    const now = new Date().toISOString();
    await db
      .prepare("INSERT INTO runs (run_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(runId, sessionId, "running", now, now)
      .run();
  });
}

export async function finishRun(db: D1Database, runId: string, error?: string): Promise<void> {
  await runWithRetry(async () => {
    await db
      .prepare("UPDATE runs SET status=?, error=?, updated_at=? WHERE run_id=?")
      .bind(error ? "failed" : "succeeded", error ?? null, new Date().toISOString(), runId)
      .run();
  });
}
