import { SessionRuntime } from "../../src/session";
import type { Env } from "../../src/types";

type SqlResult = { meta: { changes?: number } };

export class FakeD1 {
  readonly updates = new Set<number>();
  readonly oauthStates = new Map<string, Record<string, unknown>>();
  readonly oauthTokens = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => this.run(sql, args),
        all: async () => this.all(sql),
        first: async () => this.first(sql, args),
      }),
      all: async () => this.all(sql),
      first: async () => this.first(sql, []),
    };
  }

  private async all(_sql: string): Promise<{ results: Array<{ provider: string; payload: string }> }> {
    return { results: [] };
  }

  private async run(sql: string, args: unknown[]): Promise<SqlResult> {
    if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) {
      const updateId = Number(args[0]);
      const had = this.updates.has(updateId);
      this.updates.add(updateId);
      return { meta: { changes: had ? 0 : 1 } };
    }
    if (sql.includes("INSERT INTO google_oauth_states")) {
      const state = String(args[0]);
      this.oauthStates.set(state, {
        state,
        chat_id: Number(args[1]),
        telegram_user_id: Number(args[2]),
        expires_at: String(args[3]),
        used_at: null,
        created_at: String(args[4]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE google_oauth_states SET used_at")) {
      const usedAt = String(args[0]);
      const state = String(args[1]);
      const current = this.oauthStates.get(state);
      if (!current || current.used_at) {
        return { meta: { changes: 0 } };
      }
      current.used_at = usedAt;
      this.oauthStates.set(state, current);
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO google_oauth_tokens")) {
      const principal = String(args[0]);
      this.oauthTokens.set(principal, {
        principal,
        telegram_user_id: args[1] === null || args[1] === undefined ? null : Number(args[1]),
        refresh_token_ciphertext: String(args[2]),
        nonce: String(args[3]),
        scopes: String(args[4]),
        updated_at: String(args[5]),
      });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM google_oauth_tokens")) {
      const principal = String(args[0]);
      const deleted = this.oauthTokens.delete(principal);
      return { meta: { changes: deleted ? 1 : 0 } };
    }
    return { meta: { changes: 0 } };
  }

  private async first(sql: string, args: unknown[]): Promise<Record<string, unknown> | null> {
    if (sql.includes("SELECT state, chat_id, telegram_user_id, expires_at, used_at, created_at FROM google_oauth_states")) {
      const state = String(args[0]);
      return this.oauthStates.get(state) ?? null;
    }
    if (sql.includes("SELECT principal, telegram_user_id, refresh_token_ciphertext, nonce, scopes, updated_at FROM google_oauth_tokens")) {
      const principal = String(args[0]);
      return this.oauthTokens.get(principal) ?? null;
    }
    return null;
  }
}

class FakeStorage {
  private values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

class FakeDurableObjectState {
  readonly storage = new FakeStorage();
  readonly id: DurableObjectId;

  constructor(idText: string) {
    this.id = {
      toString: () => idText,
      equals: () => false,
      name: idText,
      jurisdiction: undefined,
    } as unknown as DurableObjectId;
  }
}

export function createEnv() {
  const db = new FakeD1();
  const runtimes = new Map<string, SessionRuntime>();

  const base = {
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "secret-1",
    TELEGRAM_ALLOWED_USER_ID: "42",
    AI_PROVIDER: "opencode-go",
    MODEL: "kimi-k2.5",
    BASE_URL: "https://opencode.ai/zen/go/v1",
    OPENCODE_API_KEY: "test-opencode-key",
    GOOGLE_OAUTH_CLIENT_ID: "test-google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "test-google-client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://worker.test/google/oauth/callback",
    GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/gmail.readonly",
    GOOGLE_OAUTH_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    CODE_EXEC_ENABLED: "false",
    MEMORY_ENABLED: "false",
    DRECLAW_DB: db as unknown as D1Database,
  };

  const namespace = {
    idFromName(name: string) {
      return { toString: () => name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const key = id.toString();
      let runtime = runtimes.get(key);
      if (!runtime) {
        runtime = new SessionRuntime(new FakeDurableObjectState(key) as unknown as DurableObjectState, {
          ...base,
          SESSION_RUNTIME: namespace as unknown as DurableObjectNamespace,
        } as Env);
        runtimes.set(key, runtime);
      }
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => runtime.fetch(new Request(input, init)),
      } as unknown as DurableObjectStub;
    },
  };

  const env: Env = {
    ...base,
    SESSION_RUNTIME: namespace as unknown as DurableObjectNamespace,
  };

  return { env, db };
}
