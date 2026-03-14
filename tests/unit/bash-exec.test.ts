import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { executeBash } from "../../src/core/tools/bash";

afterEach(() => {
  vi.restoreAllMocks();
});

function createVfs(initialFiles: Record<string, string> = {}) {
  const files = new Map(Object.entries(initialFiles));
  return {
    files,
    adapter: {
      readFile: async (path: string) => files.get(path) ?? null,
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
        return { ok: true as const };
      },
      listFiles: async (prefix: string, limit: number) =>
        [...files.keys()]
          .filter((path) => path.startsWith(prefix))
          .sort()
          .slice(0, limit),
      removeFile: async (path: string) => files.delete(path),
    },
  };
}

const config = {
  execMaxOutputBytes: 65_536,
  netRequestTimeoutMs: 5_000,
  netMaxResponseBytes: 65_536,
  netMaxRedirects: 5,
  vfsMaxFiles: 100,
};

describe("bash-exec", () => {
  it("runs shell commands and persists created files", async () => {
    const { adapter, files } = createVfs({ "/notes.txt": "alpha\nbeta\n" });

    const result = await executeBash(
      { command: "grep beta /notes.txt > /result.txt && cat /result.txt" },
      { config, vfs: adapter },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("beta\n");
    expect(result.writes).toContain("write /result.txt");
    expect(files.get("/result.txt")).toBe("beta\n");
  });

  it("persists deletions back to vfs", async () => {
    const { adapter, files } = createVfs({ "/remove.txt": "gone\n" });

    const result = await executeBash(
      { command: "rm /remove.txt && printf done" },
      { config, vfs: adapter },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("done");
    expect(result.writes).toContain("remove /remove.txt");
    expect(files.has("/remove.txt")).toBe(false);
  });

  it("supports curl with full network access", async () => {
    const { adapter } = createVfs();
    const fetchMock = vi.fn(
      async () =>
        new Response("network-ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeBash(
      { command: "curl -s https://example.com/demo" },
      { config, vfs: adapter },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("network-ok");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("does not enable sqlite3", async () => {
    const { adapter } = createVfs();

    const result = await executeBash(
      { command: 'sqlite3 :memory: "SELECT 1"' },
      { config, vfs: adapter },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("sqlite3");
  });
});
