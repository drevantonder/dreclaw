import { Bash } from "just-bash";
import { R2FilesystemService } from "./filesystem";
import { isToolName } from "./tool-schema";
import { VFS_ROOT, type RunResult, type ToolCall } from "./types";

export function extractToolCall(output: string): ToolCall | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  const direct = tryParseJson(trimmed);
  if (direct) return normalizeToolCall(direct);

  const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1];
  if (fenced) {
    const parsed = tryParseJson(fenced);
    if (parsed) return normalizeToolCall(parsed);
  }

  return null;
}

export interface ToolRuntimeContext {
  shell: SessionShell;
  deferPersistence?: boolean;
}

export interface FilesystemMetrics {
  ensureLoadedCalls: number;
  ensureLoadedColdStarts: number;
  flushCalls: number;
  flushMsTotal: number;
  flushMsMax: number;
  captureChangesCalls: number;
  scannedPaths: number;
  changedPathMarks: number;
  deletedPathMarks: number;
  r2ListCalls: number;
  r2GetCalls: number;
  r2GetBytes: number;
  r2PutCalls: number;
  r2PutBytes: number;
  r2DeleteBatches: number;
  r2DeleteKeys: number;
}

const EMPTY_FS_METRICS: FilesystemMetrics = {
  ensureLoadedCalls: 0,
  ensureLoadedColdStarts: 0,
  flushCalls: 0,
  flushMsTotal: 0,
  flushMsMax: 0,
  captureChangesCalls: 0,
  scannedPaths: 0,
  changedPathMarks: 0,
  deletedPathMarks: 0,
  r2ListCalls: 0,
  r2GetCalls: 0,
  r2GetBytes: 0,
  r2PutCalls: 0,
  r2PutBytes: 0,
  r2DeleteBatches: 0,
  r2DeleteKeys: 0,
};

export class SessionShell {
  private bash: Bash | null = null;
  private baselinePaths = new Set<string>();
  private persistedFilePaths = new Set<string>();
  private changedPaths = new Set<string>();
  private deletedPaths = new Set<string>();
  private syncedHashes = new Map<string, string>();
  private metrics: FilesystemMetrics = { ...EMPTY_FS_METRICS };

  constructor(private readonly fs: R2FilesystemService) {}

  normalizePath(path: string): string {
    return this.fs.normalizePath(path);
  }

  metricsSnapshot(): FilesystemMetrics {
    return { ...this.metrics };
  }

  metricsDelta(since: FilesystemMetrics): FilesystemMetrics {
    return diffMetrics(this.metrics, since);
  }

  async readText(path: string): Promise<string> {
    await this.ensureLoaded();
    const normalized = this.fs.normalizePath(path);
    return this.bash!.fs.readFile(normalized, "utf8");
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.ensureLoaded();
    const normalized = this.fs.normalizePath(path);
    await this.bash!.writeFile(normalized, content);
    this.changedPaths.add(normalized);
    this.deletedPaths.delete(normalized);
  }

  async edit(path: string, find: string, replace: string): Promise<void> {
    await this.ensureLoaded();
    const normalized = this.fs.normalizePath(path);
    const current = await this.bash!.fs.readFile(normalized, "utf8");
    if (!current.includes(find)) throw new Error(`Text not found in ${normalized}`);
    await this.bash!.writeFile(normalized, current.replace(find, replace));
    this.changedPaths.add(normalized);
    this.deletedPaths.delete(normalized);
  }

  async run(command: string): Promise<RunResult> {
    await this.ensureLoaded();
    const result = await this.bash!.exec(command, { cwd: VFS_ROOT, env: shellEnv() });
    await this.captureBashChanges();
    return toRunResult({ success: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
  }

  async flush(): Promise<void> {
    const startedAt = Date.now();
    this.metrics.flushCalls += 1;
    await this.ensureLoaded();
    await this.captureBashChanges();
    await this.syncToPersistence();
    const elapsed = Date.now() - startedAt;
    this.metrics.flushMsTotal += elapsed;
    if (elapsed > this.metrics.flushMsMax) this.metrics.flushMsMax = elapsed;
  }

  private async ensureLoaded(): Promise<void> {
    this.metrics.ensureLoadedCalls += 1;
    if (this.bash) return;
    this.metrics.ensureLoadedColdStarts += 1;

    const files: Record<string, Uint8Array> = {};
    this.metrics.r2ListCalls += 1;
    const persistedPaths = await this.fs.list(VFS_ROOT);
    await runWithConcurrency(persistedPaths, 16, async (path) => {
      const content = await this.fs.read(path);
      files[path] = content;
      this.persistedFilePaths.add(path);
      this.syncedHashes.set(path, hashBytes(content));
      this.metrics.r2GetCalls += 1;
      this.metrics.r2GetBytes += content.byteLength;
    });

    this.bash = new Bash({ files, cwd: VFS_ROOT, env: shellEnv() });
    await this.bash.exec("mkdir -p /.config /.cache /workspace", { cwd: VFS_ROOT, env: shellEnv() });
    this.baselinePaths = new Set(this.bash.fs.getAllPaths().filter((path) => path.startsWith("/")));
  }

  private async syncToPersistence(): Promise<void> {
    if (!this.bash) return;

    const putPaths = [...this.changedPaths].filter((path) => !this.deletedPaths.has(path));
    await runWithConcurrency(putPaths, 16, async (path) => {
      const content = await this.bash!.fs.readFileBuffer(path);
      await this.fs.write(path, content);
      this.persistedFilePaths.add(path);
      this.syncedHashes.set(path, hashBytes(content));
      this.metrics.r2PutCalls += 1;
      this.metrics.r2PutBytes += content.byteLength;
    });

    const deletes = [...this.deletedPaths];
    if (deletes.length) {
      await this.fs.deleteMany(deletes);
      this.metrics.r2DeleteBatches += 1;
      this.metrics.r2DeleteKeys += deletes.length;
      for (const path of deletes) {
        this.persistedFilePaths.delete(path);
        this.syncedHashes.delete(path);
      }
    }

    this.changedPaths.clear();
    this.deletedPaths.clear();
  }

  private async captureBashChanges(): Promise<void> {
    if (!this.bash) return;
    this.metrics.captureChangesCalls += 1;
    const currentFiles = new Set<string>();
    const allPaths = this.bash.fs.getAllPaths().filter((path) => path.startsWith("/"));
    this.metrics.scannedPaths += allPaths.length;
    for (const path of allPaths) {
      try {
        const stat = await this.bash.fs.stat(path);
        if (!stat.isFile) continue;
        currentFiles.add(path);
        const content = await this.bash.fs.readFileBuffer(path);
        const currentHash = hashBytes(content);
        const syncedHash = this.syncedHashes.get(path);
        if (syncedHash === undefined && this.baselinePaths.has(path) && !this.changedPaths.has(path)) {
          continue;
        }
        if (syncedHash !== currentHash && !this.changedPaths.has(path)) {
          this.changedPaths.add(path);
          this.metrics.changedPathMarks += 1;
        }
      } catch {
        continue;
      }
    }

    for (const path of this.persistedFilePaths) {
      if (!currentFiles.has(path) && !this.deletedPaths.has(path)) {
        this.deletedPaths.add(path);
        this.metrics.deletedPathMarks += 1;
      }
    }
  }
}

export async function runTool(tool: ToolCall, context: ToolRuntimeContext): Promise<RunResult> {
  try {
    const handlers = {
      read: async (): Promise<RunResult> => {
        const path = String(tool.args.path ?? "");
        const output = await context.shell.readText(path);
        return { ok: true, output };
      },
      write: async (): Promise<RunResult> => {
        const path = String(tool.args.path ?? "");
        const content = String(tool.args.content ?? "");
        await context.shell.writeText(path, content);
        return { ok: true, output: `Wrote ${context.shell.normalizePath(path)}` };
      },
      edit: async (): Promise<RunResult> => {
        const path = String(tool.args.path ?? "");
        const find = String(tool.args.find ?? "");
        const replace = String(tool.args.replace ?? "");
        await context.shell.edit(path, find, replace);
        return { ok: true, output: `Edited ${path}` };
      },
      bash: async (): Promise<RunResult> => {
        const command = String(tool.args.command ?? "");
        return context.shell.run(command);
      },
    } as const;

    const result = await handlers[tool.name]();
    if (!context.deferPersistence && (tool.name === "write" || tool.name === "edit" || tool.name === "bash")) {
      await context.shell.flush();
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return;
  const chunkLimit = Math.max(1, limit);
  const queue = [...items];
  const workers = Array.from({ length: Math.min(chunkLimit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function hashBytes(content: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of content) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function diffMetrics(current: FilesystemMetrics, since: FilesystemMetrics): FilesystemMetrics {
  return {
    ensureLoadedCalls: current.ensureLoadedCalls - since.ensureLoadedCalls,
    ensureLoadedColdStarts: current.ensureLoadedColdStarts - since.ensureLoadedColdStarts,
    flushCalls: current.flushCalls - since.flushCalls,
    flushMsTotal: current.flushMsTotal - since.flushMsTotal,
    flushMsMax: current.flushMsMax,
    captureChangesCalls: current.captureChangesCalls - since.captureChangesCalls,
    scannedPaths: current.scannedPaths - since.scannedPaths,
    changedPathMarks: current.changedPathMarks - since.changedPathMarks,
    deletedPathMarks: current.deletedPathMarks - since.deletedPathMarks,
    r2ListCalls: current.r2ListCalls - since.r2ListCalls,
    r2GetCalls: current.r2GetCalls - since.r2GetCalls,
    r2GetBytes: current.r2GetBytes - since.r2GetBytes,
    r2PutCalls: current.r2PutCalls - since.r2PutCalls,
    r2PutBytes: current.r2PutBytes - since.r2PutBytes,
    r2DeleteBatches: current.r2DeleteBatches - since.r2DeleteBatches,
    r2DeleteKeys: current.r2DeleteKeys - since.r2DeleteKeys,
  };
}

function tryParseJson(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function normalizeToolCall(input: unknown): ToolCall | null {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  const root = (data.tool && typeof data.tool === "object" ? data.tool : data) as Record<string, unknown>;
  const name = String(root.name ?? "");
  if (!isToolName(name)) return null;
  const args = (root.args && typeof root.args === "object" ? root.args : {}) as Record<string, unknown>;
  return { name, args };
}

function shellEnv(): Record<string, string> {
  const configHome = VFS_ROOT === "/" ? "/.config" : `${VFS_ROOT}/.config`;
  const cacheHome = VFS_ROOT === "/" ? "/.cache" : `${VFS_ROOT}/.cache`;
  return {
    HOME: VFS_ROOT,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
  };
}

function toRunResult(result: { success: boolean; stdout?: string; stderr?: string; exitCode?: number }): RunResult {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  if (result.success) return { ok: true, output };
  const code = typeof result.exitCode === "number" ? ` (exit ${result.exitCode})` : "";
  return {
    ok: false,
    output,
    error: `Command failed${code}`,
  };
}
