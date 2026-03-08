import { Bash, getCommandNames, type CommandName } from "just-bash/browser";

export interface BashInput {
  command: string;
  cwd?: string;
  stdin?: string;
}

export interface BashExecutionConfig {
  execMaxOutputBytes: number;
  netRequestTimeoutMs: number;
  netMaxResponseBytes: number;
  netMaxRedirects: number;
  vfsMaxFiles: number;
}

export interface BashVfsAdapter {
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string, overwrite: boolean) => Promise<{ ok: true } | { ok: false; code: string }>;
  listFiles: (prefix: string, limit: number) => Promise<string[]>;
  removeFile: (path: string) => Promise<boolean>;
}

export interface BashResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  writes: string[];
  error?: {
    code: string;
    message: string;
  };
}

type BashHostContext = {
  config: BashExecutionConfig;
  vfs: BashVfsAdapter;
};

const DISABLED_COMMANDS = new Set(["sqlite3"]);
const ENABLED_COMMANDS = getCommandNames().filter((name) => !DISABLED_COMMANDS.has(name)) as CommandName[];

let systemPathCache: Promise<Set<string>> | null = null;

export async function executeBash(payload: BashInput, ctx: BashHostContext): Promise<BashResult> {
  const cwd = normalizeShellPath(payload.cwd);
  const initialFiles = await loadInitialFiles(ctx.vfs, ctx.config.vfsMaxFiles);
  const initialUserPaths = new Set(Object.keys(initialFiles));
  const shell = new Bash({
    cwd,
    files: initialFiles,
    commands: ENABLED_COMMANDS,
    network: {
      dangerouslyAllowFullInternetAccess: true,
      timeoutMs: ctx.config.netRequestTimeoutMs,
      maxResponseSize: ctx.config.netMaxResponseBytes,
      maxRedirects: ctx.config.netMaxRedirects,
    },
    executionLimits: {
      maxStringLength: ctx.config.execMaxOutputBytes,
    },
  });

  try {
    const result = await shell.exec(payload.command, {
      cwd,
      stdin: payload.stdin ?? "",
      rawScript: true,
    });
    const sync = await syncFilesystem(shell, initialFiles, initialUserPaths, ctx.vfs);
    const stderr = [result.stderr.trimEnd(), ...sync.errors].filter(Boolean).join("\n");
    const ok = result.exitCode === 0 && sync.errors.length === 0;
    return {
      ok,
      stdout: result.stdout,
      stderr,
      exitCode: result.exitCode,
      cwd: String(result.env.PWD || cwd),
      writes: sync.writes,
      ...(ok ? {} : { error: { code: sync.errors.length ? "BASH_PERSIST_FAILED" : "BASH_EXIT_NONZERO", message: stderr || `Command exited with ${result.exitCode}` } }),
    };
  } catch (error) {
    const message = compactErrorMessage(error);
    return {
      ok: false,
      stdout: "",
      stderr: message,
      exitCode: 126,
      cwd,
      writes: [],
      error: { code: "BASH_EXEC_FAILED", message },
    };
  }
}

async function loadInitialFiles(vfs: BashVfsAdapter, limit: number): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const paths = await vfs.listFiles("/", limit);
  for (const path of paths) {
    if (path.startsWith("/skills/system/")) continue;
    const content = await vfs.readFile(path);
    if (content !== null) files[path] = content;
  }
  return files;
}

async function syncFilesystem(
  shell: Bash,
  initialFiles: Record<string, string>,
  initialUserPaths: Set<string>,
  vfs: BashVfsAdapter,
): Promise<{ writes: string[]; errors: string[] }> {
  const writes: string[] = [];
  const errors: string[] = [];
  const systemPaths = await getSystemPaths();
  const finalUserFilePaths = new Set<string>();

  for (const path of shell.fs.getAllPaths()) {
    if (systemPaths.has(path)) continue;
    const stat = await shell.fs.lstat(path);
    if (stat.isDirectory) continue;
    if (stat.isSymbolicLink) {
      errors.push(`persist unsupported for symlink: ${path}`);
      continue;
    }
    if (!stat.isFile) continue;
    finalUserFilePaths.add(path);
    const content = await shell.readFile(path);
    if (initialFiles[path] === content) continue;
    const write = await vfs.writeFile(path, content, true);
    if (write.ok) writes.push(`write ${path}`);
    else errors.push(`persist failed for ${path}: ${write.code}`);
  }

  for (const path of initialUserPaths) {
    if (finalUserFilePaths.has(path)) continue;
    const deleted = await vfs.removeFile(path);
    if (deleted) writes.push(`remove ${path}`);
    else errors.push(`persist failed for ${path}: ENOENT`);
  }

  return { writes, errors };
}

async function getSystemPaths(): Promise<Set<string>> {
  if (!systemPathCache) {
    systemPathCache = Promise.resolve(
      new Set(
        new Bash({
          cwd: "/",
          commands: ENABLED_COMMANDS,
          network: { dangerouslyAllowFullInternetAccess: true },
        }).fs.getAllPaths(),
      ),
    );
  }
  return systemPathCache;
}

function normalizeShellPath(path: string | undefined): string {
  const value = String(path ?? "").trim();
  if (!value || value === ".") return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function compactErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error ?? "Unknown error");
}
