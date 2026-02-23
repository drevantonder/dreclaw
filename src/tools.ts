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
}

export class SessionShell {
  private bash: Bash | null = null;

  constructor(private readonly fs: R2FilesystemService) {}

  normalizePath(path: string): string {
    return this.fs.normalizePath(path);
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
    await this.syncToPersistence();
  }

  async edit(path: string, find: string, replace: string): Promise<void> {
    await this.ensureLoaded();
    const normalized = this.fs.normalizePath(path);
    const current = await this.bash!.fs.readFile(normalized, "utf8");
    if (!current.includes(find)) throw new Error(`Text not found in ${normalized}`);
    await this.bash!.writeFile(normalized, current.replace(find, replace));
    await this.syncToPersistence();
  }

  async run(command: string): Promise<RunResult> {
    await this.ensureLoaded();
    const result = await this.bash!.exec(command, { cwd: VFS_ROOT, env: shellEnv() });
    await this.syncToPersistence();
    return toRunResult({ success: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.bash) return;

    const files: Record<string, Uint8Array> = {};
    const persistedPaths = await this.fs.list(VFS_ROOT);
    for (const path of persistedPaths) {
      files[path] = await this.fs.read(path);
    }

    this.bash = new Bash({ files, cwd: VFS_ROOT, env: shellEnv() });
    await this.bash.exec("mkdir -p /.config /.cache /workspace", { cwd: VFS_ROOT, env: shellEnv() });
  }

  private async syncToPersistence(): Promise<void> {
    if (!this.bash) return;

    const files: Record<string, Uint8Array> = {};
    for (const path of this.bash.fs.getAllPaths()) {
      if (!path.startsWith("/")) continue;
      try {
        const stat = await this.bash.fs.stat(path);
        if (!stat.isFile) continue;
        files[path] = await this.bash.fs.readFileBuffer(path);
      } catch {
        continue;
      }
    }
    await this.fs.replaceAll(files);
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

    return await handlers[tool.name]();
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
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
