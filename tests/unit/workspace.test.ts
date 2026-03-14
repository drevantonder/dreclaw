import { describe, expect, it } from "vite-plus/test";
import { createWorkspace } from "../../src/workspace";

type Statement = {
  bind: (...args: unknown[]) => Statement;
  run: () => Promise<{ meta: { changes?: number } }>;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
};

function createMockDb(options?: {
  runChanges?: number;
  firstQueue?: Array<Record<string, unknown> | null>;
  allRows?: Record<string, unknown>[];
  captureSql?: string[];
  captureBind?: unknown[][];
}): D1Database {
  const captureSql = options?.captureSql ?? [];
  const captureBind = options?.captureBind ?? [];
  const firstQueue = [...(options?.firstQueue ?? [])];
  const stmt: Statement = {
    bind: (...args: unknown[]) => {
      captureBind.push(args);
      return stmt;
    },
    run: async () => ({ meta: { changes: options?.runChanges ?? 1 } }),
    first: async <T>() => (firstQueue.shift() ?? null) as T | null,
    all: async <T>() => ({ results: (options?.allRows ?? []) as T[] }),
  };

  return {
    prepare: (sql: string) => {
      captureSql.push(sql);
      return stmt as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

describe("workspace", () => {
  it("normalizes paths and overlays builtin skills", async () => {
    const workspace = createWorkspace({
      db: createMockDb({ allRows: [{ path: "/scripts/demo.js" }] }),
      maxFileBytes: 1024,
    });

    expect(workspace.normalizePath("vfs:/skills/system/google/../google/SKILL.md")).toBe(
      "/skills/system/google/SKILL.md",
    );
    await expect(workspace.readFile("/skills/system/google/SKILL.md")).resolves.toContain(
      "# Google",
    );
    await expect(workspace.listFiles("/skills/system", 20)).resolves.toContain(
      "/skills/system/google/SKILL.md",
    );
  });

  it("lists builtin and valid user skills", async () => {
    const workspace = createWorkspace({
      db: createMockDb({
        allRows: [
          {
            path: "/skills/user/inbox-summary/SKILL.md",
            content:
              "---\nname: inbox-summary\ndescription: Summarize inbox messages when asked.\n---\n\n# Inbox Summary",
          },
          {
            path: "/skills/user/google/SKILL.md",
            content: "---\nname: google\ndescription: Invalid override.\n---\n\n# Override",
          },
          { path: "/skills/user/bad/SKILL.md", content: "not frontmatter" },
        ],
      }),
      maxFileBytes: 1024,
    });

    const skills = await workspace.listSkills();
    expect(skills.map((skill) => skill.name)).toContain("google");
    expect(skills.map((skill) => skill.name)).toContain("inbox-summary");
    expect(skills.map((skill) => skill.name)).not.toContain("bad");
    expect(skills.filter((skill) => skill.name === "google")).toHaveLength(1);
  });

  it("loads a user skill and validates its name", async () => {
    const workspace = createWorkspace({
      db: createMockDb({
        firstQueue: [
          {
            path: "/skills/user/inbox-summary/SKILL.md",
            content:
              "---\nname: inbox-summary\ndescription: Summarize inbox messages when asked.\n---\n\n# Inbox Summary",
          },
        ],
      }),
      maxFileBytes: 1024,
    });

    await expect(workspace.loadSkill("inbox-summary")).resolves.toMatchObject({
      name: "inbox-summary",
      scope: "user",
    });
  });

  it("rejects reserved or oversized skill writes", async () => {
    const sql: string[] = [];
    const binds: unknown[][] = [];
    const workspace = createWorkspace({
      db: createMockDb({ captureSql: sql, captureBind: binds }),
      maxFileBytes: 24,
    });

    await expect(
      workspace.writeFile(
        "/skills/user/google/SKILL.md",
        "---\nname: google\ndescription: no\n---\n\n# Bad",
        true,
      ),
    ).rejects.toThrow("SKILL_RESERVED: google");

    await expect(
      workspace.writeFile("/notes.txt", "abcdefghijklmnopqrstuvwxyz", true),
    ).resolves.toEqual({ ok: false, code: "VFS_LIMIT_EXCEEDED" });

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hello"));
    const expectedHash = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    await expect(workspace.writeFile("/notes.txt", "hello", true)).resolves.toEqual({
      ok: true,
      path: "/notes.txt",
    });
    expect(sql.some((value) => value.includes("INSERT INTO vfs_entries"))).toBe(true);
    expect(
      binds.some((value) => value.includes("/notes.txt") && value.includes(expectedHash)),
    ).toBe(true);
  });
});
