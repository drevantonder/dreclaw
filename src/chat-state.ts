import type { Lock, StateAdapter } from "chat";

export function createD1StateAdapter(db: D1Database): StateAdapter {
  return new D1StateAdapter(db);
}

class D1StateAdapter implements StateAdapter {
  constructor(private readonly db: D1Database) {}

  async connect(): Promise<void> {
    return;
  }

  async disconnect(): Promise<void> {
    return;
  }

  async subscribe(threadId: string): Promise<void> {
    const nowIso = now();
    await this.db
      .prepare(
        "INSERT INTO chat_state_subscriptions (thread_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at",
      )
      .bind(threadId, nowIso, nowIso)
      .run();
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM chat_state_subscriptions WHERE thread_id = ?")
      .bind(threadId)
      .run();
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT thread_id FROM chat_state_subscriptions WHERE thread_id = ?")
      .bind(threadId)
      .first<Record<string, unknown>>();
    return Boolean(row?.thread_id);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    await this.deleteExpiredKv(key);
    const row = await this.db
      .prepare("SELECT value_json FROM chat_state_kv WHERE key = ?")
      .bind(key)
      .first<Record<string, unknown>>();
    if (!row?.value_json || typeof row.value_json !== "string") return null;
    return JSON.parse(row.value_json) as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const nowIso = now();
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
    await this.db
      .prepare(
        "INSERT INTO chat_state_kv (key, value_json, expires_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at",
      )
      .bind(key, JSON.stringify(value), expiresAt, nowIso)
      .run();
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    await this.deleteExpiredKv(key);
    const nowIso = now();
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
    const result = await this.db
      .prepare(
        "INSERT OR IGNORE INTO chat_state_kv (key, value_json, expires_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(key, JSON.stringify(value), expiresAt, nowIso)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM chat_state_kv WHERE key = ?").bind(key).run();
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const currentIso = now();
    await this.db
      .prepare("DELETE FROM chat_state_locks WHERE thread_id = ? AND expires_at <= ?")
      .bind(threadId, currentIso)
      .run();

    const lock: Lock = {
      threadId,
      token: crypto.randomUUID(),
      expiresAt: Date.now() + ttlMs,
    };
    const expiresIso = new Date(lock.expiresAt).toISOString();
    const result = await this.db
      .prepare(
        "INSERT OR IGNORE INTO chat_state_locks (thread_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(threadId, lock.token, expiresIso, currentIso, currentIso)
      .run();
    return result.meta.changes && result.meta.changes > 0 ? lock : null;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const nextExpiresAt = Date.now() + ttlMs;
    const result = await this.db
      .prepare(
        "UPDATE chat_state_locks SET expires_at = ?, updated_at = ? WHERE thread_id = ? AND token = ? AND expires_at > ?",
      )
      .bind(new Date(nextExpiresAt).toISOString(), now(), lock.threadId, lock.token, now())
      .run();
    if (!(result.meta.changes && result.meta.changes > 0)) return false;
    lock.expiresAt = nextExpiresAt;
    return true;
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.db
      .prepare("DELETE FROM chat_state_locks WHERE thread_id = ? AND token = ?")
      .bind(lock.threadId, lock.token)
      .run();
  }

  private async deleteExpiredKv(key: string): Promise<void> {
    await this.db
      .prepare(
        "DELETE FROM chat_state_kv WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .bind(key, now())
      .run();
  }
}

function now(): string {
  return new Date().toISOString();
}
