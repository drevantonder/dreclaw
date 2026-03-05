import { describe, expect, it, vi } from "vitest";
import {
  countVfsEntries,
  createGoogleOAuthState,
  deleteVfsEntry,
  deleteGoogleOAuthToken,
  getVfsEntry,
  getVfsRevision,
  getGoogleOAuthState,
  getGoogleOAuthToken,
  listVfsEntries,
  markGoogleOAuthStateUsed,
  markUpdateSeen,
  putVfsEntry,
  upsertGoogleOAuthToken,
} from "../../src/db";

type Statement = {
  bind: (...args: unknown[]) => Statement;
  run: () => Promise<{ meta: { changes?: number } }>;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
};

function createMockDb(options?: {
  runChanges?: number;
  firstRow?: Record<string, unknown> | null;
  allRows?: Record<string, unknown>[];
  captureSql?: string[];
  captureBind?: unknown[][];
}): D1Database {
  const captureSql = options?.captureSql ?? [];
  const captureBind = options?.captureBind ?? [];
  const stmt: Statement = {
    bind: (...args: unknown[]) => {
      captureBind.push(args);
      return stmt;
    },
    run: async () => ({ meta: { changes: options?.runChanges ?? 1 } }),
    first: async <T>() => (options?.firstRow ?? null) as T | null,
    all: async <T>() => ({ results: ((options?.allRows ?? []) as T[]) }),
  };

  return {
    prepare: (sql: string) => {
      captureSql.push(sql);
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

describe("db", () => {
  it("marks update id as seen", async () => {
    const sql: string[] = [];
    const binds: unknown[][] = [];
    const db = createMockDb({ captureSql: sql, captureBind: binds });
    const ok = await markUpdateSeen(db, 101);
    expect(ok).toBe(true);
    expect(sql[0]).toContain("INSERT OR IGNORE INTO telegram_updates");
    expect(binds[0]?.[0]).toBe(101);
  });

  it("creates and loads oauth state", async () => {
    const inserts: string[] = [];
    const insertBinds: unknown[][] = [];
    const createDb = createMockDb({ captureSql: inserts, captureBind: insertBinds });
    await createGoogleOAuthState(createDb, {
      state: "abc",
      chatId: 777,
      telegramUserId: 42,
      expiresAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(inserts[0]).toContain("INSERT INTO google_oauth_states");
    expect(insertBinds[0]).toEqual(["abc", 777, 42, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);

    const selectDb = createMockDb({
      firstRow: {
        state: "abc",
        chat_id: 777,
        telegram_user_id: 42,
        expires_at: "2026-01-01T00:00:00.000Z",
        used_at: null,
        created_at: "2025-12-31T23:00:00.000Z",
      },
    });
    const loaded = await getGoogleOAuthState(selectDb, "abc");
    expect(loaded).toEqual({
      state: "abc",
      chatId: 777,
      telegramUserId: 42,
      expiresAt: "2026-01-01T00:00:00.000Z",
      usedAt: null,
      createdAt: "2025-12-31T23:00:00.000Z",
    });
  });

  it("marks oauth state used once", async () => {
    const db = createMockDb({ runChanges: 1 });
    const ok = await markGoogleOAuthStateUsed(db, "state-1", "2026-01-01T00:00:00.000Z");
    expect(ok).toBe(true);

    const noopDb = createMockDb({ runChanges: 0 });
    const second = await markGoogleOAuthStateUsed(noopDb, "state-1", "2026-01-01T00:00:01.000Z");
    expect(second).toBe(false);
  });

  it("upserts, reads, and deletes oauth token", async () => {
    const sql: string[] = [];
    const binds: unknown[][] = [];
    const upsertDb = createMockDb({ captureSql: sql, captureBind: binds });
    await upsertGoogleOAuthToken(upsertDb, {
      principal: "default",
      telegramUserId: 42,
      refreshTokenCiphertext: "cipher",
      nonce: "nonce",
      scopes: "gmail.readonly",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(sql[0]).toContain("INSERT INTO google_oauth_tokens");
    expect(binds[0]).toEqual(["default", 42, "cipher", "nonce", "gmail.readonly", "2026-01-01T00:00:00.000Z"]);

    const readDb = createMockDb({
      firstRow: {
        principal: "default",
        telegram_user_id: 42,
        refresh_token_ciphertext: "cipher",
        nonce: "nonce",
        scopes: "gmail.readonly",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    const token = await getGoogleOAuthToken(readDb, "default");
    expect(token?.principal).toBe("default");

    const deleteDb = createMockDb({ runChanges: 1 });
    const deleted = await deleteGoogleOAuthToken(deleteDb, "default");
    expect(deleted).toBe(true);
  });

  it("retries once on transient errors", async () => {
    let calls = 0;
    const stmt = {
      bind: () => stmt,
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { meta: { changes: 1 } };
      },
      first: async <T>() => null as T | null,
    };
    const db = {
      prepare: vi.fn(() => stmt),
    } as unknown as D1Database;

    const ok = await markUpdateSeen(db, 202);
    expect(ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("supports vfs revision + file crud", async () => {
    const sql: string[] = [];
    const binds: unknown[][] = [];
    const db = createMockDb({
      captureSql: sql,
      captureBind: binds,
      firstRow: {
        revision: 7,
        path: "/scripts/demo.js",
        content: "export default 1;",
        size_bytes: 17,
        sha256: "abc",
        version: 2,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      allRows: [
        {
          path: "/scripts/demo.js",
          content: "export default 1;",
          size_bytes: 17,
          sha256: "abc",
          version: 2,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const revision = await getVfsRevision(db);
    expect(revision).toBe(7);

    const put = await putVfsEntry(db, {
      path: "/scripts/demo.js",
      content: "export default 1;",
      sizeBytes: 17,
      sha256: "abc",
      nowIso: "2026-01-01T00:00:00.000Z",
      overwrite: true,
    });
    expect(put.ok).toBe(true);

    const got = await getVfsEntry(db, "/scripts/demo.js");
    expect(got?.path).toBe("/scripts/demo.js");

    const list = await listVfsEntries(db, "/scripts", 20);
    expect(list[0]?.path).toBe("/scripts/demo.js");

    const count = await countVfsEntries(db);
    expect(typeof count).toBe("number");

    const removed = await deleteVfsEntry(db, "/scripts/demo.js", "2026-01-01T00:01:00.000Z");
    expect(removed).toBe(true);

    expect(sql.some((entry) => entry.includes("vfs_entries"))).toBe(true);
    expect(binds.length).toBeGreaterThan(0);
  });
});
