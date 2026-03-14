import type { Env } from "../../src/types";

type SqlResult = { meta: { changes?: number } };

export class FakeD1 {
  readonly telegramUpdates = new Set<number>();
  readonly oauthStates = new Map<string, Record<string, unknown>>();
  readonly oauthTokens = new Map<string, Record<string, unknown>>();
  readonly vfsEntries = new Map<string, Record<string, unknown>>();
  readonly subscriptions = new Map<string, Record<string, unknown>>();
  readonly kv = new Map<string, Record<string, unknown>>();
  readonly locks = new Map<string, Record<string, unknown>>();
  vfsRevision = 0;

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => this.run(sql, args),
        all: async () => this.all(sql, args),
        first: async () => this.first(sql, args),
      }),
      all: async () => this.all(sql, []),
      first: async () => this.first(sql, []),
    };
  }

  private async all(
    sql: string,
    _args: unknown[],
  ): Promise<{ results: Array<Record<string, unknown>> }> {
    if (sql.includes("FROM vfs_entries")) {
      return {
        results: [...this.vfsEntries.values()].filter(
          (row) => row.deleted_at === null || row.deleted_at === undefined,
        ),
      };
    }
    return { results: [] };
  }

  private async run(sql: string, args: unknown[]): Promise<SqlResult> {
    if (sql.includes("INSERT INTO google_oauth_states")) {
      this.oauthStates.set(String(args[0]), {
        state: String(args[0]),
        chat_id: Number(args[1]),
        telegram_user_id: Number(args[2]),
        expires_at: String(args[3]),
        used_at: null,
        created_at: String(args[4]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) {
      const updateId = Number(args[0]);
      if (this.telegramUpdates.has(updateId)) return { meta: { changes: 0 } };
      this.telegramUpdates.add(updateId);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE google_oauth_states SET used_at")) {
      const row = this.oauthStates.get(String(args[1]));
      if (!row || row.used_at) return { meta: { changes: 0 } };
      row.used_at = String(args[0]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO google_oauth_tokens")) {
      this.oauthTokens.set(String(args[0]), {
        principal: String(args[0]),
        telegram_user_id: args[1] == null ? null : Number(args[1]),
        refresh_token_ciphertext: String(args[2]),
        nonce: String(args[3]),
        scopes: String(args[4]),
        updated_at: String(args[5]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM google_oauth_tokens")) {
      return { meta: { changes: this.oauthTokens.delete(String(args[0])) ? 1 : 0 } };
    }
    if (sql.includes("INSERT INTO chat_state_subscriptions")) {
      this.subscriptions.set(String(args[0]), {
        thread_id: String(args[0]),
        created_at: String(args[1]),
        updated_at: String(args[2]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_state_subscriptions")) {
      return { meta: { changes: this.subscriptions.delete(String(args[0])) ? 1 : 0 } };
    }
    if (
      sql.includes("INSERT INTO chat_state_kv") ||
      sql.includes("INSERT OR IGNORE INTO chat_state_kv")
    ) {
      const key = String(args[0]);
      const exists = this.kv.has(key);
      if (sql.includes("INSERT OR IGNORE") && exists) return { meta: { changes: 0 } };
      this.kv.set(key, {
        key,
        value_json: String(args[1]),
        expires_at: args[2] == null ? null : String(args[2]),
        updated_at: String(args[3]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_state_kv WHERE key = ? AND expires_at")) {
      const row = this.kv.get(String(args[0]));
      if (!row || row.expires_at == null || String(row.expires_at) > String(args[1]))
        return { meta: { changes: 0 } };
      this.kv.delete(String(args[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_state_kv WHERE key = ?")) {
      return { meta: { changes: this.kv.delete(String(args[0])) ? 1 : 0 } };
    }
    if (sql.includes("DELETE FROM chat_state_locks WHERE thread_id = ? AND expires_at")) {
      const row = this.locks.get(String(args[0]));
      if (!row || String(row.expires_at) > String(args[1])) return { meta: { changes: 0 } };
      this.locks.delete(String(args[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO chat_state_locks")) {
      const key = String(args[0]);
      if (this.locks.has(key)) return { meta: { changes: 0 } };
      this.locks.set(key, {
        thread_id: key,
        token: String(args[1]),
        expires_at: String(args[2]),
        created_at: String(args[3]),
        updated_at: String(args[4]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE chat_state_locks SET expires_at")) {
      const row = this.locks.get(String(args[2]));
      if (
        !row ||
        String(row.token) !== String(args[3]) ||
        String(row.expires_at) <= String(args[4])
      )
        return { meta: { changes: 0 } };
      row.expires_at = String(args[0]);
      row.updated_at = String(args[1]);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM chat_state_locks WHERE thread_id = ? AND token = ?")) {
      const row = this.locks.get(String(args[0]));
      if (!row || String(row.token) !== String(args[1])) return { meta: { changes: 0 } };
      this.locks.delete(String(args[0]));
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO vfs_entries")) {
      this.vfsEntries.set(String(args[0]), {
        path: String(args[0]),
        content: String(args[1]),
        size_bytes: Number(args[2]),
        sha256: String(args[3]),
        version: Number(args[4]),
        created_at: String(args[5]),
        updated_at: String(args[6]),
        deleted_at: null,
      });
      return { meta: { changes: 1 } };
    }
    if (
      sql.includes(
        "UPDATE vfs_entries SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE path = ?",
      )
    ) {
      const row = this.vfsEntries.get(String(args[2]));
      if (!row || row.deleted_at) return { meta: { changes: 0 } };
      row.deleted_at = String(args[0]);
      row.updated_at = String(args[1]);
      row.version = Number(row.version ?? 0) + 1;
      return { meta: { changes: 1 } };
    }
    if (
      sql.includes(
        "UPDATE vfs_entries SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE deleted_at IS NULL",
      )
    ) {
      let changes = 0;
      for (const row of this.vfsEntries.values()) {
        if (row.deleted_at) continue;
        row.deleted_at = String(args[0]);
        row.updated_at = String(args[1]);
        row.version = Number(row.version ?? 0) + 1;
        changes += 1;
      }
      return { meta: { changes } };
    }
    if (sql.includes("INSERT OR IGNORE INTO vfs_meta")) return { meta: { changes: 1 } };
    if (sql.includes("UPDATE vfs_meta SET revision = revision + 1")) {
      this.vfsRevision += 1;
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }

  private async first(sql: string, args: unknown[]): Promise<Record<string, unknown> | null> {
    if (sql.includes("FROM google_oauth_states"))
      return this.oauthStates.get(String(args[0])) ?? null;
    if (sql.includes("FROM google_oauth_tokens"))
      return this.oauthTokens.get(String(args[0])) ?? null;
    if (sql.includes("FROM chat_state_subscriptions"))
      return this.subscriptions.get(String(args[0])) ?? null;
    if (sql.includes("SELECT value_json FROM chat_state_kv"))
      return this.kv.get(String(args[0])) ?? null;
    if (
      sql.includes(
        "SELECT path, content, size_bytes, sha256, version, created_at, updated_at FROM vfs_entries WHERE path = ?",
      )
    ) {
      const row = this.vfsEntries.get(String(args[0]));
      return !row || row.deleted_at ? null : row;
    }
    if (sql.includes("SELECT revision FROM vfs_meta")) return { revision: this.vfsRevision };
    if (sql.includes("SELECT COUNT(*) AS count FROM vfs_entries")) {
      return {
        count: [...this.vfsEntries.values()].filter((row) => row.deleted_at == null).length,
      };
    }
    return null;
  }
}

export function createEnv(overrides?: Partial<Env>) {
  const db = new FakeD1();
  const env: Env = {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_BOT_USERNAME: "dreclawbot",
    TELEGRAM_ALLOWED_USER_ID: "42",
    MODEL: "test-model",
    OPENCODE_API_KEY: "test-key",
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://test.local/google/oauth/callback",
    GOOGLE_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    MEMORY_ENABLED: "false",
    DRECLAW_DB: db as unknown as D1Database,
    ...overrides,
  };
  return { env, db };
}
