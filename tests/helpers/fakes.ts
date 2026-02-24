import { SessionRuntime } from "../../src/session";
import type { Env } from "../../src/types";

type SqlResult = { meta: { changes?: number } };

export class FakeD1 {
  readonly updates = new Set<number>();

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => this.run(sql, args),
        all: async () => this.all(sql),
      }),
      all: async () => this.all(sql),
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
    return { meta: { changes: 0 } };
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
    MODEL: "kimi-k2.5-free",
    BASE_URL: "https://opencode.ai/zen/v1",
    OPENCODE_ZEN_API_KEY: "test-zen-key",
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
