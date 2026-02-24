import { newQuickJSAsyncWASMModuleFromVariant } from "quickjs-emscripten-core";
import QUICKJS_ASYNC_SINGLEFILE_VARIANT from "@jitl/quickjs-singlefile-cjs-release-asyncify";

export interface InstalledPackage {
  spec: string;
  resolvedUrl: string;
  entryUrl: string;
  sha256: string;
  sizeBytes: number;
  installedAt: string;
}

export interface CodeRuntimeState {
  installedPackages: InstalledPackage[];
}

export interface ExecuteInput {
  code: string;
  input?: unknown;
}

export interface SearchInput {
  query?: string;
}

export interface ExecuteResult {
  ok: boolean;
  result: unknown;
  logs: Array<{ level: "log" | "warn" | "error"; text: string }>;
  stats: {
    durationMs: number;
    hostCalls: number;
    fetchRequests: number;
    fetchBytes: number;
    fetchErrors: number;
    packageInstalls: number;
  };
  error?: {
    code: string;
    message: string;
  };
}

export interface SearchResult {
  runtime: {
    engine: "quickjs-emscripten";
    apis: string[];
    limits: CodeExecutionLimits;
  };
  packages: InstalledPackage[];
}

export interface CodeExecutionLimits {
  execTimeoutMs: number;
  execMemoryMb: number;
  execStackKb: number;
  execMaxHostCalls: number;
  execMaxLogLines: number;
  execMaxOutputBytes: number;
  netMaxRequestsPerRun: number;
  netMaxParallel: number;
  netRequestTimeoutMs: number;
  netMaxResponseBytes: number;
  netMaxTotalDownloadBytes: number;
  netMaxRedirects: number;
  pkgInstallTimeoutMs: number;
  pkgMaxSpecLength: number;
  pkgMaxModuleBytes: number;
  pkgMaxTotalInstallBytesPerRun: number;
  pkgMaxInstallsPerRun: number;
}

export interface CodeExecutionConfig {
  codeExecEnabled: boolean;
  netFetchEnabled: boolean;
  pkgInstallEnabled: boolean;
  limits: CodeExecutionLimits;
}

type HostContext = {
  config: CodeExecutionConfig;
  state: CodeRuntimeState;
  saveState: (state: CodeRuntimeState) => Promise<void>;
};

type HostStats = {
  hostCalls: number;
  fetchRequests: number;
  fetchBytes: number;
  fetchErrors: number;
  packageInstalls: number;
};

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSAsyncWASMModuleFromVariant>>;
type QuickJsContext = ReturnType<QuickJsModule["newContext"]>;

let quickJsModulePromise: Promise<QuickJsModule> | null = null;

const DEFAULT_LIMITS: CodeExecutionLimits = {
  execTimeoutMs: 2000,
  execMemoryMb: 32,
  execStackKb: 512,
  execMaxHostCalls: 25,
  execMaxLogLines: 120,
  execMaxOutputBytes: 65_536,
  netMaxRequestsPerRun: 25,
  netMaxParallel: 5,
  netRequestTimeoutMs: 10_000,
  netMaxResponseBytes: 2_097_152,
  netMaxTotalDownloadBytes: 10_485_760,
  netMaxRedirects: 5,
  pkgInstallTimeoutMs: 15_000,
  pkgMaxSpecLength: 120,
  pkgMaxModuleBytes: 3_145_728,
  pkgMaxTotalInstallBytesPerRun: 15_728_640,
  pkgMaxInstallsPerRun: 5,
};

export function normalizeCodeRuntimeState(state: CodeRuntimeState | undefined): CodeRuntimeState {
  if (!state || !Array.isArray(state.installedPackages)) {
    return { installedPackages: [] };
  }
  const normalized: InstalledPackage[] = [];
  const seen = new Set<string>();
  for (const pkg of state.installedPackages) {
    if (!pkg || typeof pkg !== "object") continue;
    const value = pkg as Partial<InstalledPackage>;
    if (typeof value.spec !== "string" || typeof value.entryUrl !== "string" || typeof value.resolvedUrl !== "string") continue;
    if (seen.has(value.spec)) continue;
    seen.add(value.spec);
    normalized.push({
      spec: value.spec,
      entryUrl: value.entryUrl,
      resolvedUrl: value.resolvedUrl,
      sha256: typeof value.sha256 === "string" ? value.sha256 : "",
      sizeBytes: typeof value.sizeBytes === "number" ? value.sizeBytes : 0,
      installedAt: typeof value.installedAt === "string" ? value.installedAt : new Date(0).toISOString(),
    });
  }
  return { installedPackages: normalized };
}

export function getCodeExecutionConfig(env: Record<string, string | undefined>): CodeExecutionConfig {
  return {
    codeExecEnabled: parseFlag(env.CODE_EXEC_ENABLED, true),
    netFetchEnabled: parseFlag(env.NET_FETCH_ENABLED, true),
    pkgInstallEnabled: parseFlag(env.PKG_INSTALL_ENABLED, true),
    limits: {
      execTimeoutMs: parsePositiveInt(env.EXEC_TIMEOUT_MS, DEFAULT_LIMITS.execTimeoutMs),
      execMemoryMb: parsePositiveInt(env.EXEC_MEMORY_MB, DEFAULT_LIMITS.execMemoryMb),
      execStackKb: parsePositiveInt(env.EXEC_STACK_KB, DEFAULT_LIMITS.execStackKb),
      execMaxHostCalls: parsePositiveInt(env.EXEC_MAX_HOST_CALLS, DEFAULT_LIMITS.execMaxHostCalls),
      execMaxLogLines: parsePositiveInt(env.EXEC_MAX_LOG_LINES, DEFAULT_LIMITS.execMaxLogLines),
      execMaxOutputBytes: parsePositiveInt(env.EXEC_MAX_OUTPUT_BYTES, DEFAULT_LIMITS.execMaxOutputBytes),
      netMaxRequestsPerRun: parsePositiveInt(env.NET_MAX_REQUESTS_PER_RUN, DEFAULT_LIMITS.netMaxRequestsPerRun),
      netMaxParallel: parsePositiveInt(env.NET_MAX_PARALLEL, DEFAULT_LIMITS.netMaxParallel),
      netRequestTimeoutMs: parsePositiveInt(env.NET_REQUEST_TIMEOUT_MS, DEFAULT_LIMITS.netRequestTimeoutMs),
      netMaxResponseBytes: parsePositiveInt(env.NET_MAX_RESPONSE_BYTES, DEFAULT_LIMITS.netMaxResponseBytes),
      netMaxTotalDownloadBytes: parsePositiveInt(env.NET_MAX_TOTAL_DOWNLOAD_BYTES, DEFAULT_LIMITS.netMaxTotalDownloadBytes),
      netMaxRedirects: parsePositiveInt(env.NET_MAX_REDIRECTS, DEFAULT_LIMITS.netMaxRedirects),
      pkgInstallTimeoutMs: parsePositiveInt(env.PKG_INSTALL_TIMEOUT_MS, DEFAULT_LIMITS.pkgInstallTimeoutMs),
      pkgMaxSpecLength: parsePositiveInt(env.PKG_MAX_SPEC_LENGTH, DEFAULT_LIMITS.pkgMaxSpecLength),
      pkgMaxModuleBytes: parsePositiveInt(env.PKG_MAX_MODULE_BYTES, DEFAULT_LIMITS.pkgMaxModuleBytes),
      pkgMaxTotalInstallBytesPerRun: parsePositiveInt(
        env.PKG_MAX_TOTAL_INSTALL_BYTES_PER_RUN,
        DEFAULT_LIMITS.pkgMaxTotalInstallBytesPerRun,
      ),
      pkgMaxInstallsPerRun: parsePositiveInt(env.PKG_MAX_INSTALLS_PER_RUN, DEFAULT_LIMITS.pkgMaxInstallsPerRun),
    },
  };
}

export function searchCodeRuntime(payload: SearchInput, ctx: HostContext): SearchResult {
  const query = String(payload.query ?? "").trim().toLowerCase();
  const list = [...ctx.state.installedPackages].sort((a, b) => a.spec.localeCompare(b.spec));
  const packages = query ? list.filter((pkg) => pkg.spec.toLowerCase().includes(query)) : list;
  return {
    runtime: {
      engine: "quickjs-emscripten",
      apis: ["pkg.install", "pkg.list", "fetch", "console.log", "console.warn", "console.error"],
      limits: ctx.config.limits,
    },
    packages,
  };
}

export async function executeCode(payload: ExecuteInput, ctx: HostContext): Promise<ExecuteResult> {
  const startedAt = Date.now();
  const logs: Array<{ level: "log" | "warn" | "error"; text: string }> = [];
  const stats: HostStats = {
    hostCalls: 0,
    fetchRequests: 0,
    fetchBytes: 0,
    fetchErrors: 0,
    packageInstalls: 0,
  };

  if (!ctx.config.codeExecEnabled) {
    return {
      ok: false,
      result: null,
      logs,
      stats: { ...stats, durationMs: Date.now() - startedAt },
      error: { code: "CODE_EXEC_DISABLED", message: "Code execution is disabled" },
    };
  }

  const code = typeof payload.code === "string" ? payload.code : "";
  if (!code.trim()) {
    return {
      ok: false,
      result: null,
      logs,
      stats: { ...stats, durationMs: Date.now() - startedAt },
      error: { code: "INVALID_INPUT", message: "code must be a non-empty string" },
    };
  }

  const quickJs = await getQuickJsModule();
  const vm = quickJs.newContext();
  const runtime = vm.runtime;
  const limits = ctx.config.limits;
  const deadline = Date.now() + limits.execTimeoutMs;

  runtime.setMemoryLimit(limits.execMemoryMb * 1024 * 1024);
  runtime.setMaxStackSize(limits.execStackKb * 1024);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  runtime.setModuleLoader(
    async (moduleName: string) => loadModuleSource(moduleName, ctx, stats),
    async (baseModuleName: string, requestedName: string) => normalizeModuleName(baseModuleName, requestedName),
  );

  try {
    registerHostApi(vm, ctx, logs, stats);
    await setGlobalJson(vm, "__host_input", payload.input ?? null);
    vm.unwrapResult(vm.evalCode(bootstrapRuntimeSource())).dispose();

    const valueHandle = vm.unwrapResult(vm.evalCode(code, "execute.js"));
    const evalValue = vm.dump(valueHandle);
    valueHandle.dispose();

    runPendingJobs(vm.runtime, limits.execMaxHostCalls);

    const explicitResult = readGlobalJson(vm, "__exec_result");
    const result = explicitResult === null ? evalValue : explicitResult;
    return {
      ok: true,
      result: clampOutput(result, limits.execMaxOutputBytes),
      logs,
      stats: {
        ...stats,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    return {
      ok: false,
      result: null,
      logs,
      stats: {
        ...stats,
        durationMs: Date.now() - startedAt,
      },
      error: classifyExecutionError(error),
    };
  } finally {
    vm.runtime.removeInterruptHandler();
    vm.dispose();
  }
}

function registerHostApi(
  vm: QuickJsContext,
  ctx: HostContext,
  logs: Array<{ level: "log" | "warn" | "error"; text: string }>,
  stats: HostStats,
): void {
  const limits = ctx.config.limits;

  const logFn = vm.newFunction("__host_log", (levelHandle, messageHandle) => {
    bumpHostCall(stats, limits.execMaxHostCalls);
    const level = vm.getString(levelHandle);
    const text = truncate(vm.getString(messageHandle), 1200);
    if (logs.length < limits.execMaxLogLines && (level === "log" || level === "warn" || level === "error")) {
      logs.push({ level, text });
    }
  });
  vm.setProp(vm.global, "__host_log", logFn);
  logFn.dispose();

  const pkgListFn = vm.newFunction("__host_pkg_list", () => {
    bumpHostCall(stats, limits.execMaxHostCalls);
    return vm.newString(JSON.stringify(ctx.state.installedPackages));
  });
  vm.setProp(vm.global, "__host_pkg_list", pkgListFn);
  pkgListFn.dispose();

  const pkgInstallFn = vm.newAsyncifiedFunction("__host_pkg_install", async (specHandle) => {
    bumpHostCall(stats, limits.execMaxHostCalls);
    if (!ctx.config.pkgInstallEnabled) {
      throw new Error("PKG_INSTALL_DISABLED");
    }
    const spec = vm.getString(specHandle);
    const installed = await ensurePackageInstalled(spec, ctx, stats);
    return vm.newString(JSON.stringify(installed));
  });
  vm.setProp(vm.global, "__host_pkg_install", pkgInstallFn);
  pkgInstallFn.dispose();

  const fetchFn = vm.newAsyncifiedFunction("__host_fetch", async (argsHandle) => {
    bumpHostCall(stats, limits.execMaxHostCalls);
    if (!ctx.config.netFetchEnabled) {
      throw new Error("NET_FETCH_DISABLED");
    }
    const args = safeJsonParse(vm.getString(argsHandle));
    if (!Array.isArray(args) || !args.length || typeof args[0] !== "string") {
      throw new Error("fetch requires url string");
    }
    const request = await executeFetch(args[0], args[1] ?? {}, ctx.config.limits, stats);
    return vm.newString(JSON.stringify(request));
  });
  vm.setProp(vm.global, "__host_fetch", fetchFn);
  fetchFn.dispose();
}

function bootstrapRuntimeSource(): string {
  return `
globalThis.__exec_result = null;

const __toText = (value) => {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

globalThis.console = {
  log: (...args) => globalThis.__host_log("log", args.map(__toText).join(" ")),
  warn: (...args) => globalThis.__host_log("warn", args.map(__toText).join(" ")),
  error: (...args) => globalThis.__host_log("error", args.map(__toText).join(" ")),
};

globalThis.pkg = {
  install: async (spec) => JSON.parse(await globalThis.__host_pkg_install(String(spec))),
  list: async () => JSON.parse(globalThis.__host_pkg_list()),
};

globalThis.fetch = async (url, init = {}) => {
  const payload = JSON.parse(await globalThis.__host_fetch(JSON.stringify([String(url), init])));
  return {
    ok: Boolean(payload.ok),
    status: Number(payload.status || 0),
    statusText: String(payload.statusText || ""),
    url: String(payload.url || ""),
    headers: payload.headers || {},
    text: async () => String(payload.bodyText || ""),
    json: async () => JSON.parse(String(payload.bodyText || "null")),
  };
};

globalThis.input = globalThis.__host_input;
`;
}

function runPendingJobs(runtime: { hasPendingJob: () => boolean; executePendingJobs: (max?: number) => { error?: unknown } }, max: number): void {
  let iterations = 0;
  while (runtime.hasPendingJob()) {
    if (iterations >= max) {
      throw new Error("Maximum pending job iterations exceeded");
    }
    const result = runtime.executePendingJobs();
    if (result && "error" in result && result.error) {
      throw new Error("Pending jobs failed");
    }
    iterations += 1;
  }
}

async function ensurePackageInstalled(spec: string, ctx: HostContext, stats: HostStats): Promise<InstalledPackage> {
  const normalizedSpec = normalizePackageSpec(spec, ctx.config.limits.pkgMaxSpecLength);
  const existing = ctx.state.installedPackages.find((item) => item.spec === normalizedSpec);
  if (existing) return existing;

  if (stats.packageInstalls >= ctx.config.limits.pkgMaxInstallsPerRun) {
    throw new Error("Package install limit exceeded for this run");
  }

  const baseUrl = `https://esm.sh/${normalizedSpec}?bundle&target=es2022`;
  const indexRes = await fetchWithTimeout(baseUrl, ctx.config.limits.pkgInstallTimeoutMs);
  if (!indexRes.ok) {
    throw new Error(`Package resolution failed for ${normalizedSpec}`);
  }
  const indexText = await indexRes.text();
  const entry = resolveEsmEntry(indexRes.url, indexText);
  const entryRes = await fetchWithTimeout(entry, ctx.config.limits.pkgInstallTimeoutMs);
  if (!entryRes.ok) {
    throw new Error(`Package entry fetch failed for ${normalizedSpec}`);
  }
  const source = await entryRes.text();
  const sizeBytes = new TextEncoder().encode(source).byteLength;
  if (sizeBytes > ctx.config.limits.pkgMaxModuleBytes) {
    throw new Error(`Package module too large: ${sizeBytes}`);
  }
  stats.packageInstalls += 1;
  const installed: InstalledPackage = {
    spec: normalizedSpec,
    resolvedUrl: indexRes.url,
    entryUrl: entryRes.url,
    sha256: await sha256Hex(source),
    sizeBytes,
    installedAt: new Date().toISOString(),
  };

  ctx.state.installedPackages = [...ctx.state.installedPackages, installed].sort((a, b) => a.spec.localeCompare(b.spec));
  await ctx.saveState(ctx.state);
  return installed;
}

async function loadModuleSource(moduleName: string, ctx: HostContext, stats: HostStats): Promise<string> {
  if (moduleName.startsWith("npm:")) {
    const spec = moduleName.slice(4);
    const installed = await ensurePackageInstalled(spec, ctx, stats);
    const response = await fetchWithTimeout(installed.entryUrl, ctx.config.limits.pkgInstallTimeoutMs);
    if (!response.ok) {
      throw new Error(`Failed to load module for ${installed.spec}`);
    }
    return await response.text();
  }

  if (moduleName.startsWith("https://esm.sh/") || moduleName.startsWith("https://cdn.jsdelivr.net/")) {
    const response = await fetchWithTimeout(moduleName, ctx.config.limits.pkgInstallTimeoutMs);
    if (!response.ok) {
      throw new Error(`Failed to load module: ${moduleName}`);
    }
    return await response.text();
  }

  if (moduleName.startsWith("/")) {
    const url = `https://esm.sh${moduleName}`;
    const response = await fetchWithTimeout(url, ctx.config.limits.pkgInstallTimeoutMs);
    if (!response.ok) {
      throw new Error(`Failed to load module path: ${moduleName}`);
    }
    return await response.text();
  }

  throw new Error(`Unsupported module: ${moduleName}`);
}

function normalizeModuleName(baseModuleName: string, requestedName: string): string {
  if (requestedName.startsWith("npm:")) return requestedName;
  if (requestedName.startsWith("https://")) return requestedName;
  if (requestedName.startsWith("/")) return `https://esm.sh${requestedName}`;
  if (baseModuleName.startsWith("https://")) {
    return new URL(requestedName, baseModuleName).toString();
  }
  if (baseModuleName.startsWith("/")) {
    return new URL(requestedName, `https://esm.sh${baseModuleName}`).toString();
  }
  return requestedName;
}

async function executeFetch(url: string, init: unknown, limits: CodeExecutionLimits, stats: HostStats): Promise<Record<string, unknown>> {
  if (stats.fetchRequests >= limits.netMaxRequestsPerRun) {
    throw new Error("fetch request limit exceeded");
  }
  stats.fetchRequests += 1;

  const normalizedInit = normalizeFetchInit(init, limits.netMaxRedirects);
  const response = await fetchWithTimeout(url, limits.netRequestTimeoutMs, normalizedInit);
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > limits.netMaxResponseBytes) {
    stats.fetchErrors += 1;
    throw new Error("fetch response exceeded max bytes");
  }
  stats.fetchBytes += bytes;
  if (stats.fetchBytes > limits.netMaxTotalDownloadBytes) {
    stats.fetchErrors += 1;
    throw new Error("total fetch bytes exceeded for run");
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers,
    bodyText: text,
  };
}

function normalizeFetchInit(init: unknown, maxRedirects: number): RequestInit {
  const obj = init && typeof init === "object" ? (init as Record<string, unknown>) : {};
  const method = typeof obj.method === "string" ? obj.method.toUpperCase() : "GET";
  const headers = obj.headers && typeof obj.headers === "object" ? (obj.headers as HeadersInit) : undefined;
  const body = typeof obj.body === "string" ? obj.body : undefined;
  const redirect = obj.redirect === "error" || obj.redirect === "manual" || obj.redirect === "follow" ? obj.redirect : "follow";
  if (redirect === "follow" && maxRedirects < 0) {
    throw new Error("Invalid redirect limit");
  }
  return {
    method,
    headers,
    body,
    redirect,
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function resolveEsmEntry(resolvedUrl: string, indexSource: string): string {
  const patterns = [
    /export\s+\*\s+from\s+["']([^"']+)["']/,
    /export\s+\{[^}]*\}\s+from\s+["']([^"']+)["']/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(indexSource);
    if (!match) continue;
    const next = match[1];
    if (next.startsWith("/")) return `https://esm.sh${next}`;
    return new URL(next, resolvedUrl).toString();
  }
  return resolvedUrl;
}

function normalizePackageSpec(spec: string, maxLength: number): string {
  const normalized = String(spec ?? "").trim();
  if (!normalized) throw new Error("Package spec is required");
  if (normalized.length > maxLength) throw new Error("Package spec too long");
  if (!/^[a-zA-Z0-9@/._+-]+$/.test(normalized)) {
    throw new Error("Unsupported package spec characters");
  }
  return normalized;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function classifyExecutionError(error: unknown): { code: string; message: string } {
  const text = error instanceof Error ? error.message : String(error ?? "Unknown error");
  if (text.includes("interrupt")) return { code: "TIMEOUT", message: "Execution timed out" };
  if (text.includes("PKG_INSTALL_DISABLED")) return { code: "PKG_INSTALL_DISABLED", message: "Package install is disabled" };
  if (text.includes("NET_FETCH_DISABLED")) return { code: "NET_FETCH_DISABLED", message: "Network fetch is disabled" };
  if (text.includes("Maximum pending job iterations exceeded")) {
    return { code: "MAX_PENDING_JOBS", message: "Too many pending jobs" };
  }
  return { code: "EXECUTION_ERROR", message: truncate(text, 500) };
}

function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function bumpHostCall(stats: HostStats, maxHostCalls: number): void {
  stats.hostCalls += 1;
  if (stats.hostCalls > maxHostCalls) {
    throw new Error("Maximum host calls exceeded");
  }
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars - 1)}…`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getQuickJsModule(): Promise<QuickJsModule> {
  if (!quickJsModulePromise) {
    quickJsModulePromise = newQuickJSAsyncWASMModuleFromVariant(QUICKJS_ASYNC_SINGLEFILE_VARIANT);
  }
  return quickJsModulePromise;
}

async function setGlobalJson(vm: QuickJsContext, key: string, value: unknown): Promise<void> {
  const handle = vm.newString(JSON.stringify(value));
  vm.setProp(vm.global, key, handle);
  handle.dispose();
  vm.unwrapResult(vm.evalCode(`globalThis.${key} = JSON.parse(globalThis.${key});`)).dispose();
}

function readGlobalJson(vm: QuickJsContext, key: string): unknown {
  const resultHandle = vm.getProp(vm.global, key);
  try {
    return vm.dump(resultHandle);
  } finally {
    resultHandle.dispose();
  }
}


function clampOutput(value: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(value);
  if (!text) return value;
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes <= maxBytes) return value;
  const truncated = text.slice(0, Math.max(1, maxBytes - 24));
  return { truncated: true, output: `${truncated}…` };
}
