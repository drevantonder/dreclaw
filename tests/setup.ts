import { afterEach, vi } from "vite-plus/test";

function normalizePath(rawPath: string): string {
  const input = String(rawPath ?? "").trim() || "/";
  const path = input.startsWith("/") ? input : `/${input}`;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function globToRegExp(pattern: string): RegExp {
  let i = 0;
  let output = "^";
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        output += ".*";
      } else {
        i += 1;
        output += "[^/]*";
      }
    } else if (char === "?") {
      i += 1;
      output += ".";
    } else {
      output += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  output += "$";
  return new RegExp(output);
}

const mockWorkspaceStore = vi.hoisted(() => ({
  files: new Map<
    string,
    {
      type: "file" | "directory" | "symlink";
      content?: string | Uint8Array;
      target?: string;
      createdAt: number;
      updatedAt: number;
    }
  >(),
}));

function ensureDirectory(path: string) {
  const normalized = normalizePath(path);
  if (normalized === "/") return;
  if (!mockWorkspaceStore.files.has(normalized)) {
    ensureDirectory(dirname(normalized));
    const now = Date.now();
    mockWorkspaceStore.files.set(normalized, {
      type: "directory",
      createdAt: now,
      updatedAt: now,
    });
  }
}

function listAllPaths() {
  return [...mockWorkspaceStore.files.keys()].sort();
}

vi.mock("@cloudflare/shell", () => {
  class Workspace {
    constructor(_host?: unknown, _options?: unknown) {}

    async readFile(path: string) {
      const entry = mockWorkspaceStore.files.get(normalizePath(path));
      if (!entry || entry.type !== "file") return null;
      return typeof entry.content === "string"
        ? entry.content
        : new TextDecoder().decode(entry.content ?? new Uint8Array());
    }

    async readFileBytes(path: string) {
      const entry = mockWorkspaceStore.files.get(normalizePath(path));
      if (!entry || entry.type !== "file") return null;
      return typeof entry.content === "string"
        ? new TextEncoder().encode(entry.content)
        : (entry.content as Uint8Array);
    }

    async writeFile(path: string, content: string) {
      const normalized = normalizePath(path);
      ensureDirectory(dirname(normalized));
      const now = Date.now();
      const current = mockWorkspaceStore.files.get(normalized);
      mockWorkspaceStore.files.set(normalized, {
        type: "file",
        content,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
    }

    async writeFileBytes(path: string, content: Uint8Array | ArrayBuffer) {
      const normalized = normalizePath(path);
      ensureDirectory(dirname(normalized));
      const now = Date.now();
      const current = mockWorkspaceStore.files.get(normalized);
      mockWorkspaceStore.files.set(normalized, {
        type: "file",
        content: content instanceof Uint8Array ? content : new Uint8Array(content),
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
    }

    async appendFile(path: string, content: string) {
      const current = (await this.readFile(path)) ?? "";
      await this.writeFile(path, current + content);
    }

    async exists(path: string) {
      return mockWorkspaceStore.files.has(normalizePath(path));
    }

    async lstat(path: string) {
      const normalized = normalizePath(path);
      const entry = mockWorkspaceStore.files.get(normalized);
      if (!entry) return null;
      return {
        path: normalized,
        name: basename(normalized),
        type: entry.type,
        mimeType: "text/plain",
        size:
          entry.type === "file"
            ? typeof entry.content === "string"
              ? new TextEncoder().encode(entry.content).byteLength
              : (entry.content?.byteLength ?? 0)
            : 0,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        target: entry.target,
      };
    }

    async stat(path: string) {
      return this.lstat(path);
    }

    async mkdir(path: string, _opts?: { recursive?: boolean }) {
      ensureDirectory(path);
    }

    async readDir(dir = "/", opts?: { limit?: number; offset?: number }) {
      const normalized = normalizePath(dir);
      const seen = new Map<string, ReturnType<Workspace["lstat"]>>();
      for (const path of listAllPaths()) {
        if (path === normalized || !path.startsWith(normalized === "/" ? "/" : `${normalized}/`))
          continue;
        const rest = path.slice(normalized === "/" ? 1 : normalized.length + 1);
        const name = rest.split("/")[0];
        if (!name || seen.has(name)) continue;
        const childPath = normalized === "/" ? `/${name}` : `${normalized}/${name}`;
        seen.set(name, this.lstat(childPath));
      }
      const entries = await Promise.all(seen.values());
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? entries.length;
      return entries.filter(Boolean).slice(offset, offset + limit) as Awaited<
        ReturnType<Workspace["lstat"]>
      >[];
    }

    async glob(pattern: string) {
      const regex = globToRegExp(normalizePath(pattern));
      const matches = await Promise.all(
        listAllPaths()
          .filter((path) => regex.test(path))
          .map((path) => this.lstat(path)),
      );
      return matches.filter(Boolean) as Awaited<ReturnType<Workspace["lstat"]>>[];
    }

    async rm(path: string, opts?: { recursive?: boolean; force?: boolean }) {
      const normalized = normalizePath(path);
      const targets = listAllPaths().filter(
        (entry) => entry === normalized || entry.startsWith(`${normalized}/`),
      );
      if (!targets.length && !opts?.force) throw new Error(`ENOENT: ${normalized}`);
      for (const target of targets) mockWorkspaceStore.files.delete(target);
    }

    async cp(src: string, dest: string) {
      const content = await this.readFileBytes(src);
      if (content === null) throw new Error(`ENOENT: ${src}`);
      await this.writeFileBytes(dest, content);
    }

    async mv(src: string, dest: string) {
      await this.cp(src, dest);
      await this.rm(src, { force: true });
    }

    async symlink(target: string, linkPath: string) {
      const normalized = normalizePath(linkPath);
      ensureDirectory(dirname(normalized));
      const now = Date.now();
      mockWorkspaceStore.files.set(normalized, {
        type: "symlink",
        target,
        createdAt: now,
        updatedAt: now,
      });
    }

    async readlink(path: string) {
      const entry = mockWorkspaceStore.files.get(normalizePath(path));
      if (!entry || entry.type !== "symlink") throw new Error(`EINVAL: ${path}`);
      return entry.target ?? "";
    }
  }

  class FileSystemStateBackend {
    fs: any;

    constructor(fs: any) {
      this.fs = fs;
    }

    getCapabilities = async () => ({ chmod: false, utimes: false, hardLinks: false });
    readFile = async (path: string) => this.fs.readFile(path);
    readFileBytes = async (path: string) => this.fs.readFileBytes(path);
    writeFile = async (path: string, content: string) => this.fs.writeFile(path, content);
    writeFileBytes = async (path: string, content: Uint8Array) =>
      this.fs.writeFileBytes(path, content);
    appendFile = async (path: string, content: string | Uint8Array) =>
      this.fs.appendFile(path, content);
    readJson = async (path: string) => JSON.parse(await this.fs.readFile(path));
    writeJson = async (path: string, value: unknown) =>
      this.fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    queryJson = async () => null;
    updateJson = async () => ({ value: null, content: "", diff: "", operationsApplied: 0 });
    exists = async (path: string) => this.fs.exists(path);
    stat = async (path: string) => this.fs.stat(path);
    lstat = async (path: string) => this.fs.lstat(path);
    mkdir = async (path: string, opts?: { recursive?: boolean }) => this.fs.mkdir(path, opts);
    readdir = async (path: string) => this.fs.readdir(path);
    readdirWithFileTypes = async (path: string) => this.fs.readdirWithFileTypes(path);
    find = async (path: string) =>
      (await this.fs.glob(`${normalizePath(path)}/**/*`)).map((entry: string) => ({
        path: entry,
        name: basename(entry),
        type: "file",
        depth: entry.split("/").length - path.split("/").length,
        size: 0,
        mtime: new Date(),
      }));
    walkTree = async () => ({ path: "/", name: "/", type: "directory", size: 0, children: [] });
    summarizeTree = async () => ({
      files: 0,
      directories: 0,
      symlinks: 0,
      totalBytes: 0,
      maxDepth: 0,
    });
    searchText = async () => [];
    searchFiles = async () => [];
    replaceInFile = async (path: string, search: string, replacement: string) => {
      const content = await this.fs.readFile(path);
      const next = content.replace(search, replacement);
      await this.fs.writeFile(path, next);
      return { replaced: next === content ? 0 : 1, content: next };
    };
    replaceInFiles = async () => ({
      dryRun: false,
      files: [],
      totalFiles: 0,
      totalReplacements: 0,
    });
    rm = async (path: string, opts?: { recursive?: boolean; force?: boolean }) =>
      this.fs.rm(path, opts);
    cp = async (src: string, dest: string, opts?: { recursive?: boolean }) =>
      this.fs.cp(src, dest, opts);
    mv = async (src: string, dest: string) => this.fs.mv(src, dest);
    symlink = async (target: string, linkPath: string) => this.fs.symlink(target, linkPath);
    readlink = async (path: string) => this.fs.readlink(path);
    realpath = async (path: string) => this.fs.realpath(path);
    resolvePath = async (base: string, path: string) => this.fs.resolvePath(base, path);
    glob = async (pattern: string) => this.fs.glob(pattern);
    diff = async () => "";
    diffContent = async () => "";
    createArchive = async () => ({ path: "", entries: [], bytesWritten: 0 });
    listArchive = async () => [];
    extractArchive = async () => ({ destination: "", entries: [] });
    compressFile = async () => ({ path: "", destination: "", bytesWritten: 0 });
    decompressFile = async () => ({ path: "", destination: "", bytesWritten: 0 });
    hashFile = async () => "";
    detectFile = async () => ({ mime: "text/plain", description: "text", binary: false });
    removeTree = async (path: string) => this.fs.rm(path, { recursive: true, force: true });
    copyTree = async (src: string, dest: string) => this.fs.cp(src, dest, { recursive: true });
    moveTree = async (src: string, dest: string) => this.fs.mv(src, dest);
    planEdits = async () => ({ edits: [], totalChanged: 0, totalInstructions: 0 });
    applyEditPlan = async () => ({ dryRun: false, edits: [], totalChanged: 0 });
    applyEdits = async () => ({ dryRun: false, edits: [], totalChanged: 0 });
  }

  return { Workspace, FileSystemStateBackend };
});

vi.mock("@cloudflare/shell/workers", () => ({
  stateToolsFromBackend: (backend: Record<string, (...args: unknown[]) => Promise<unknown>>) => ({
    name: "state",
    positionalArgs: true,
    types: "declare const state: any;",
    tools: Object.fromEntries(
      Object.entries(backend)
        .filter(([, value]) => typeof value === "function")
        .map(([name, execute]) => [name, { description: `state.${name}`, execute }]),
    ),
  }),
}));

vi.mock("@cloudflare/codemode", () => {
  class DynamicWorkerExecutor {
    constructor(_options?: unknown) {}

    async execute(
      code: string,
      providers: Array<{
        name: string;
        fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
        positionalArgs?: boolean;
      }>,
    ) {
      const logs: string[] = [];
      const consoleProxy = {
        log: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
        warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(String).join(" ")}`),
        error: (...args: unknown[]) => logs.push(`[error] ${args.map(String).join(" ")}`),
      };
      const namespaces = Object.fromEntries(
        providers.map((provider) => [
          provider.name,
          new Proxy(
            {},
            {
              get(_target, propertyKey) {
                const fn = provider.fns[String(propertyKey)];
                if (!fn) return undefined;
                return provider.positionalArgs
                  ? (...args: unknown[]) => fn(...args)
                  : (args: unknown) => fn(args);
              },
            },
          ),
        ]),
      );
      try {
        // oxlint-disable-next-line typescript-eslint/no-implied-eval
        const fn = new Function(
          ...Object.keys(namespaces),
          "fetch",
          "console",
          `return (${code})();`,
        );
        const result = await fn(...Object.values(namespaces), fetch, consoleProxy);
        return { result, logs };
      } catch (error) {
        return {
          result: undefined,
          error: error instanceof Error ? error.message : String(error),
          logs,
        };
      }
    }
  }

  return { DynamicWorkerExecutor };
});

vi.mock("@cloudflare/codemode/ai", () => ({
  createCodeTool: (options: {
    tools: Array<{
      name?: string;
      tools: Record<string, { execute: (...args: any[]) => Promise<unknown> }>;
      positionalArgs?: boolean;
    }>;
    executor: {
      execute: (
        code: string,
        providers: unknown[],
      ) => Promise<{ result: unknown; error?: string; logs?: string[] }>;
    };
    description?: string;
  }) => ({
    description: options.description ?? "",
    inputSchema: {},
    async execute({ code }: { code: string }) {
      const providers = options.tools.map((provider) => ({
        name: provider.name ?? "codemode",
        positionalArgs: Boolean(provider.positionalArgs),
        fns: Object.fromEntries(
          Object.entries(provider.tools).map(([name, tool]) => [name, tool.execute]),
        ),
      }));
      const result = await options.executor.execute(code, providers);
      if (result.error) throw new Error(result.error);
      return { code, result: result.result, logs: result.logs };
    },
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  mockWorkspaceStore.files.clear();
});
