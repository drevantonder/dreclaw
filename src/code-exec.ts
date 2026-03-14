export interface CodeRuntimeState {
  readonly version?: number;
}

export interface ExecuteInput {
  code: string;
  input?: unknown;
}

export interface ExecuteResult {
  ok: boolean;
  result: unknown;
  logs: Array<{ level: "log" | "warn" | "error"; text: string }>;
  stats: {
    durationMs: number;
    fetchRequests: number;
    fsCalls: number;
    memoryCalls: number;
    googleCalls: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface CodeExecutionLimits {
  execTimeoutMs: number;
  execMaxLogLines: number;
  execMaxOutputBytes: number;
  netRequestTimeoutMs: number;
  netMaxResponseBytes: number;
  netMaxRedirects: number;
  vfsMaxFileBytes: number;
  vfsMaxFiles: number;
  vfsMaxPathLength: number;
  vfsListLimit: number;
}

export interface CodeExecutionConfig {
  codeExecEnabled: boolean;
  netFetchEnabled: boolean;
  limits: CodeExecutionLimits;
}

export interface ExecuteHostBinding {
  call(input: unknown): Promise<unknown>;
}

type HostContext = {
  config: CodeExecutionConfig;
  vfs?: {
    readFile: (path: string) => Promise<string | null>;
    listFiles: (prefix: string, limit: number) => Promise<string[]>;
  };
  loader?: {
    get(
      id: string,
      getCode: () => Promise<unknown>,
    ): {
      getEntrypoint(
        name?: string,
        options?: { props?: unknown },
      ): {
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      };
    };
  } | null;
  host?: ExecuteHostBinding | null;
};

const DEFAULT_LIMITS: CodeExecutionLimits = {
  execTimeoutMs: 4_000,
  execMaxLogLines: 120,
  execMaxOutputBytes: 65_536,
  netRequestTimeoutMs: 10_000,
  netMaxResponseBytes: 2_097_152,
  netMaxRedirects: 5,
  vfsMaxFileBytes: 524_288,
  vfsMaxFiles: 2_000,
  vfsMaxPathLength: 240,
  vfsListLimit: 500,
};

export function normalizeCodeRuntimeState(_state: CodeRuntimeState | undefined): CodeRuntimeState {
  return {};
}

export function getCodeExecutionConfig(
  env: Record<string, string | undefined>,
): CodeExecutionConfig {
  return {
    codeExecEnabled: parseFlag(env.CODE_EXEC_ENABLED, true),
    netFetchEnabled: parseFlag(env.NET_FETCH_ENABLED, true),
    limits: {
      execTimeoutMs: parsePositiveInt(env.EXEC_TIMEOUT_MS, DEFAULT_LIMITS.execTimeoutMs),
      execMaxLogLines: parsePositiveInt(env.EXEC_MAX_LOG_LINES, DEFAULT_LIMITS.execMaxLogLines),
      execMaxOutputBytes: parsePositiveInt(
        env.EXEC_MAX_OUTPUT_BYTES,
        DEFAULT_LIMITS.execMaxOutputBytes,
      ),
      netRequestTimeoutMs: parsePositiveInt(
        env.NET_REQUEST_TIMEOUT_MS,
        DEFAULT_LIMITS.netRequestTimeoutMs,
      ),
      netMaxResponseBytes: parsePositiveInt(
        env.NET_MAX_RESPONSE_BYTES,
        DEFAULT_LIMITS.netMaxResponseBytes,
      ),
      netMaxRedirects: parsePositiveInt(env.NET_MAX_REDIRECTS, DEFAULT_LIMITS.netMaxRedirects),
      vfsMaxFileBytes: parsePositiveInt(env.VFS_MAX_FILE_BYTES, DEFAULT_LIMITS.vfsMaxFileBytes),
      vfsMaxFiles: parsePositiveInt(env.VFS_MAX_FILES, DEFAULT_LIMITS.vfsMaxFiles),
      vfsMaxPathLength: parsePositiveInt(env.VFS_MAX_PATH_LENGTH, DEFAULT_LIMITS.vfsMaxPathLength),
      vfsListLimit: parsePositiveInt(env.VFS_LIST_LIMIT, DEFAULT_LIMITS.vfsListLimit),
    },
  };
}

export async function executeCode(payload: ExecuteInput, ctx: HostContext): Promise<ExecuteResult> {
  if (!ctx.config.codeExecEnabled) {
    return failResult("EXEC_DISABLED", "Code execution is disabled");
  }
  if (!ctx.loader) {
    return failResult("EXEC_LOADER_MISSING", "Worker Loader binding is not configured");
  }
  if (!ctx.host) {
    return failResult(
      "EXEC_HOST_MISSING",
      "Execute host binding is not available in this request context",
    );
  }

  try {
    const modules = await buildModules(payload.code, ctx);
    const runtimeVersion = await hashText(
      JSON.stringify({ code: payload.code, modules: Object.keys(modules).sort() }),
    );
    const worker = ctx.loader.get(`execute:${runtimeVersion}`, async () => ({
      compatibilityDate: "2026-02-22",
      mainModule: "main.js",
      modules,
      env: {
        HOST: ctx.host,
        EXEC_LIMITS: {
          execMaxLogLines: ctx.config.limits.execMaxLogLines,
          execMaxOutputBytes: ctx.config.limits.execMaxOutputBytes,
          netFetchEnabled: ctx.config.netFetchEnabled,
        },
      },
      globalOutbound: null,
    }));
    const response = await withTimeout(
      worker.getEntrypoint().fetch("https://execute.local/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: payload.input }),
      }),
      ctx.config.limits.execTimeoutMs,
      "Execution timed out",
    );
    const result = (await response.json()) as ExecuteResult;
    return sanitizeExecuteResult(result, ctx.config.limits.execMaxOutputBytes);
  } catch (error) {
    return failResult("EXEC_FAILED", compactErrorMessage(error));
  }
}

async function buildModules(
  code: string,
  ctx: HostContext,
): Promise<Record<string, { js: string } | { json: unknown }>> {
  const paths = ctx.vfs ? await ctx.vfs.listFiles("/", ctx.config.limits.vfsMaxFiles) : [];
  const vfsSpecifiers = new Map(
    paths
      .filter((path) => /\.(?:[cm]?js|json)$/i.test(path))
      .map((path) => [path, toLoaderVfsModuleName(path)]),
  );
  const modules: Record<string, { js: string } | { json: unknown }> = {
    "main.js": { js: buildMainModule(code, vfsSpecifiers) },
  };
  if (!ctx.vfs) return modules;
  for (const path of paths) {
    if (!/\.(?:[cm]?js|json)$/i.test(path)) continue;
    const content = await ctx.vfs.readFile(path);
    if (content === null) continue;
    const moduleName = vfsSpecifiers.get(path) ?? toLoaderVfsModuleName(path);
    if (path.endsWith(".json")) {
      try {
        modules[moduleName] = { json: JSON.parse(content) };
        continue;
      } catch {
        // fall through
      }
    }
    modules[moduleName] = { js: rewriteVfsImports(content, vfsSpecifiers) };
  }
  return modules;
}

function buildMainModule(code: string, vfsSpecifiers: Map<string, string>): string {
  const preparedCode = rewriteVfsImports(maybeInjectImplicitReturn(code), vfsSpecifiers);
  const staticImports = extractStaticVfsImports(preparedCode, vfsSpecifiers);
  return [
    ...staticImports.imports,
    "",
    "function formatValue(value) {",
    "  if (typeof value === 'string') return value;",
    "  try { return JSON.stringify(value); } catch { return String(value ?? ''); }",
    "}",
    "",
    "function normalizeFsWrite(args) {",
    "  if (args.length === 1 && args[0] && typeof args[0] === 'object') {",
    "    return { path: args[0].path, content: String(args[0].content ?? ''), overwrite: Boolean(args[0].overwrite) };",
    "  }",
    "  return { path: args[0], content: String(args[1] ?? ''), overwrite: Boolean(args[2]?.overwrite ?? args[2]) };",
    "}",
    "",
    "function normalizeFsRead(args) { return args.length === 1 && args[0] && typeof args[0] === 'object' ? args[0].path : args[0]; }",
    "function normalizeFsList(args) { return args.length === 1 && args[0] && typeof args[0] === 'object' ? (args[0].prefix ?? '/') : (args[0] ?? '/'); }",
    "function normalizeFsRemove(args) { return args.length === 1 && args[0] && typeof args[0] === 'object' ? args[0].path : args[0]; }",
    "",
    "function base64ToBytes(input) {",
    "  const raw = atob(input);",
    "  const bytes = new Uint8Array(raw.length);",
    "  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);",
    "  return bytes;",
    "}",
    "",
    "async function serializeFetchRequest(input, init) {",
    "  const request = input instanceof Request ? input : new Request(input, init);",
    "  const headers = Array.from(request.headers);",
    "  const bodyBuffer = request.method === 'GET' || request.method === 'HEAD' ? null : await request.clone().arrayBuffer().catch(() => null);",
    "  let bodyBase64 = null;",
    "  if (bodyBuffer && bodyBuffer.byteLength) {",
    "    let raw = '';",
    "    for (const value of new Uint8Array(bodyBuffer)) raw += String.fromCharCode(value);",
    "    bodyBase64 = btoa(raw);",
    "  }",
    "  return { url: request.url, method: request.method, headers, bodyBase64 };",
    "}",
    "",
    "function sanitizeResult(value, maxBytes) {",
    "  if (value === undefined) return null;",
    "  const text = formatValue(value);",
    "  return text.length > maxBytes ? text.slice(0, maxBytes - 1) + '…' : value;",
    "}",
    "",
    "export default {",
    "  async fetch(request, env) {",
    "    const startedAt = Date.now();",
    "    const payload = await request.json().catch(() => ({}));",
    "    const logs = [];",
    "    const stats = { durationMs: 0, fetchRequests: 0, fsCalls: 0, memoryCalls: 0, googleCalls: 0 };",
    "    const pushLog = (level, values) => {",
    "      if (logs.length >= env.EXEC_LIMITS.execMaxLogLines) return;",
    "      const text = values.map((value) => formatValue(value)).join(' ');",
    "      logs.push({ level, text: text.length > env.EXEC_LIMITS.execMaxOutputBytes ? text.slice(0, env.EXEC_LIMITS.execMaxOutputBytes - 1) + '…' : text });",
    "    };",
    "    const consoleShim = { log: (...values) => pushLog('log', values), warn: (...values) => pushLog('warn', values), error: (...values) => pushLog('error', values) };",
    "    const fs = {",
    "      read: async (...args) => { stats.fsCalls += 1; return await env.HOST.call({ action: 'fs.read', path: normalizeFsRead(args) }); },",
    "      write: async (...args) => { stats.fsCalls += 1; const write = normalizeFsWrite(args); return await env.HOST.call({ action: 'fs.write', ...write }); },",
    "      list: async (...args) => { stats.fsCalls += 1; return await env.HOST.call({ action: 'fs.list', prefix: normalizeFsList(args) }); },",
    "      remove: async (...args) => { stats.fsCalls += 1; return await env.HOST.call({ action: 'fs.remove', path: normalizeFsRemove(args) }); },",
    "    };",
    "    const memory = {",
    "      find: async (arg) => { stats.memoryCalls += 1; return await env.HOST.call({ action: 'memory.find', payload: arg }); },",
    "      save: async (arg) => { stats.memoryCalls += 1; return await env.HOST.call({ action: 'memory.save', payload: arg }); },",
    "      remove: async (arg) => { stats.memoryCalls += 1; return await env.HOST.call({ action: 'memory.remove', payload: arg }); },",
    "    };",
    "    const google = {",
    "      execute: async (arg) => { stats.googleCalls += 1; return await env.HOST.call({ action: 'google.execute', payload: arg }); },",
    "    };",
    "    const fetchShim = async (input, init) => {",
    "      if (!env.EXEC_LIMITS.netFetchEnabled) throw new Error('FETCH_DISABLED');",
    "      stats.fetchRequests += 1;",
    "      const serialized = await serializeFetchRequest(input, init);",
    "      const response = await env.HOST.call({ action: 'fetch', request: serialized });",
    "      return new Response(response.bodyBase64 ? base64ToBytes(response.bodyBase64) : null, {",
    "        status: response.status,",
    "        statusText: response.statusText,",
    "        headers: response.headers,",
    "      });",
    "    };",
    "    try {",
    "      const result = await (async (input, fs, memory, google, fetch, console) => {",
    indentCode(staticImports.code, 8),
    "      })(payload.input, fs, memory, google, fetchShim, consoleShim);",
    "      stats.durationMs = Date.now() - startedAt;",
    "      return Response.json({ ok: true, result: sanitizeResult(result, env.EXEC_LIMITS.execMaxOutputBytes), logs, stats });",
    "    } catch (error) {",
    "      stats.durationMs = Date.now() - startedAt;",
    "      return Response.json({",
    "        ok: false,",
    "        result: null,",
    "        logs,",
    "        stats,",
    "        error: { code: 'EXEC_RUNTIME_ERROR', message: error instanceof Error ? error.message : String(error ?? 'Execution failed') },",
    "      });",
    "    }",
    "  },",
    "};",
    "",
  ].join("\n");
}

function extractStaticVfsImports(
  source: string,
  vfsSpecifiers: Map<string, string>,
): { imports: string[]; code: string } {
  const imports: string[] = [];
  let index = 0;
  const code = source.replace(
    /import\((['"])(vfs:\/[^'"]+)\1\)/g,
    (_match, _quote: string, path: string) => {
      const normalizedPath = path.slice(4);
      const specifier = vfsSpecifiers.get(normalizedPath);
      if (!specifier) return _match;
      const localName = `__vfs_import_${index}`;
      imports.push(`import * as ${localName} from ${JSON.stringify(specifier)};`);
      index += 1;
      return `Promise.resolve(${localName})`;
    },
  );
  return { imports, code };
}

function maybeInjectImplicitReturn(code: string): string {
  const lines = code.split("\n");
  let index = lines.length - 1;
  while (index >= 0 && !lines[index]?.trim()) index -= 1;
  if (index < 0) return code;
  const target = lines[index].trim();
  if (!looksLikeExpressionStatement(target)) return code;
  const leading = /^\s*/.exec(lines[index])?.[0] ?? "";
  const expression = target.replace(/;\s*$/, "");
  lines[index] = `${leading}return ${expression};`;
  return lines.join("\n");
}

function looksLikeExpressionStatement(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("//") || line.startsWith("/*") || line === "{" || line === "}") return false;
  return !/^(const|let|var|if|for|while|switch|try|catch|finally|function|class|return|throw|import|export)\b/.test(
    line,
  );
}

function indentCode(code: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return code
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function rewriteVfsImports(source: string, vfsSpecifiers: Map<string, string>): string {
  let next = source;
  for (const [path, specifier] of vfsSpecifiers.entries()) {
    next = next.replaceAll(`vfs:${path}`, specifier);
  }
  return next;
}

function toLoaderVfsModuleName(path: string): string {
  return `vfs_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`;
}

function sanitizeExecuteResult(result: ExecuteResult, maxBytes: number): ExecuteResult {
  const next = { ...result };
  if (result.logs.length > DEFAULT_LIMITS.execMaxLogLines)
    next.logs = result.logs.slice(0, DEFAULT_LIMITS.execMaxLogLines);
  if (next.result !== null && next.result !== undefined) {
    const serialized = compactSerialize(next.result);
    if (serialized.length > maxBytes)
      next.result = `${serialized.slice(0, Math.max(0, maxBytes - 1))}…`;
  }
  return next;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failResult(code: string, message: string): ExecuteResult {
  return {
    ok: false,
    result: null,
    logs: [],
    stats: { durationMs: 0, fetchRequests: 0, fsCalls: 0, memoryCalls: 0, googleCalls: 0 },
    error: { code, message },
  };
}

function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function compactErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "unknown error");
  }
}

function compactSerialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

async function hashText(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
