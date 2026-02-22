import { SessionRuntime } from "../../src/session";
import type { Env } from "../../src/types";

type SqlResult = { meta: { changes?: number } };

export class FakeD1 {
  readonly updates = new Set<number>();
  readonly sessions = new Map<string, { chatId: string; model: string; authReady: boolean }>();
  readonly runs = new Map<string, { sessionId: string; status: string; error: string | null }>();

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => this.run(sql, args),
      }),
    };
  }

  private async run(sql: string, args: unknown[]): Promise<SqlResult> {
    if (sql.includes("INSERT OR IGNORE INTO telegram_updates")) {
      const updateId = Number(args[0]);
      const had = this.updates.has(updateId);
      this.updates.add(updateId);
      return { meta: { changes: had ? 0 : 1 } };
    }

    if (sql.includes("INSERT INTO sessions")) {
      const sessionId = String(args[0]);
      this.sessions.set(sessionId, {
        chatId: String(args[1]),
        model: String(args[2]),
        authReady: Number(args[3]) === 1,
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("INSERT INTO runs")) {
      const runId = String(args[0]);
      this.runs.set(runId, {
        sessionId: String(args[1]),
        status: String(args[2]),
        error: null,
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE runs SET status")) {
      const status = String(args[0]);
      const error = args[1] ? String(args[1]) : null;
      const runId = String(args[3]);
      const run = this.runs.get(runId);
      if (run) {
        run.status = status;
        run.error = error;
      }
      return { meta: { changes: run ? 1 : 0 } };
    }

    return { meta: { changes: 0 } };
  }
}

export class FakeR2 {
  readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async get(key: string): Promise<{ json: <T>() => Promise<T> } | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      json: async <T>() => JSON.parse(value) as T,
    };
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
  const bucket = new FakeR2();
  const runtimes = new Map<string, SessionRuntime>();

  const base = {
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "secret-1",
    TELEGRAM_ALLOWED_USER_ID: "42",
    DRECLAW_DB: db as unknown as D1Database,
    WORKSPACE_BUCKET: bucket as unknown as R2Bucket,
    SANDBOX: {} as DurableObjectNamespace,
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
          SANDBOX: {} as DurableObjectNamespace,
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
    SANDBOX: {} as DurableObjectNamespace,
  };

  return { env, db, bucket };
}
