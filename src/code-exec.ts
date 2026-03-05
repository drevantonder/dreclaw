import { newQuickJSAsyncWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import QUICKJS_ASYNC_WASMFILE_VARIANT from "@jitl/quickjs-wasmfile-release-asyncify";
import QUICKJS_ASYNC_WASM_MODULE from "./quickjs-release-asyncify.wasm?module";

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
    discoveryFetches: number;
    googleCalls: number;
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
  googleAuth?: {
    getAccessToken: () => Promise<{ accessToken: string; scope: string }>;
    allowedServices?: string[];
  };
};

type HostStats = {
  hostCalls: number;
  fetchRequests: number;
  fetchBytes: number;
  fetchErrors: number;
  packageInstalls: number;
  discoveryFetches: number;
  googleCalls: number;
  activeFetches: number;
  fetchWaiters: Array<() => void>;
};

type GoogleDiscoveryMethod = {
  methodPath: string;
  httpMethod: string;
  path: string;
  parameters?: Record<string, unknown>;
  request?: unknown;
  response?: unknown;
  description?: string;
};

type GoogleDiscoveryDoc = {
  rootUrl?: string;
  servicePath?: string;
  methods?: Record<string, GoogleDiscoveryMethod>;
  resources?: Record<string, unknown>;
};

const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const discoveryCache = new Map<string, { expiresAt: number; doc: GoogleDiscoveryDoc }>();

type QuickJsModule = Awaited<ReturnType<typeof newQuickJSAsyncWASMModuleFromVariant>>;
type QuickJsContext = ReturnType<QuickJsModule["newContext"]>;

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
      apis: [
        "pkg.install",
        "pkg.list",
        "fetch",
        "google.api",
        "google.schema",
        "google.execute",
        "console.log",
        "console.warn",
        "console.error",
      ],
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
    discoveryFetches: 0,
    googleCalls: 0,
    activeFetches: 0,
    fetchWaiters: [],
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
    const bootstrapResult = await vm.evalCodeAsync(bootstrapRuntimeSource());
    vm.unwrapResult(bootstrapResult).dispose();

    const valueHandle = await evalUserCodeWithAwaitFallback(vm, code);
    vm.setProp(vm.global, "__last_eval_result", valueHandle);
    valueHandle.dispose();

    const settleResult = await vm.evalCodeAsync(`
      globalThis.__exec_error = null;
      Promise.resolve(globalThis.__last_eval_result)
        .then((value) => {
          globalThis.__exec_result = value;
        })
        .catch((error) => {
          const message = error && typeof error === "object" && "message" in error ? error.message : error;
          globalThis.__exec_error = String(message ?? "Unknown execute error");
        });
    `);
    vm.unwrapResult(settleResult).dispose();

    runPendingJobs(vm.runtime, limits.execMaxHostCalls);
    await flushAsyncWork(vm.runtime, stats, deadline, limits.execMaxHostCalls);

    const errorText = readGlobalJson(vm, "__exec_error");
    if (typeof errorText === "string" && errorText.trim()) {
      throw new Error(errorText);
    }

    const result = readGlobalJson(vm, "__exec_result");
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

async function evalUserCodeWithAwaitFallback(vm: QuickJsContext, code: string) {
  try {
    const runResult = await vm.evalCodeAsync(code, "execute.js");
    return vm.unwrapResult(runResult);
  } catch (error) {
    if (!shouldRetryTopLevelAwait(error, code)) {
      throw error;
    }
    const wrapped = wrapTopLevelAwaitCode(code);
    const runResult = await vm.evalCodeAsync(wrapped, "execute.js");
    return vm.unwrapResult(runResult);
  }
}

function shouldRetryTopLevelAwait(error: unknown, code: string): boolean {
  if (!/\bawait\b/.test(code)) return false;
  const text = error instanceof Error ? error.message : String(error ?? "");
  const lowered = text.toLowerCase();
  return lowered.includes("expecting ';'") || lowered.includes("unexpected token") || lowered.includes("await");
}

function wrapTopLevelAwaitCode(code: string): string {
  const body = maybeInjectImplicitReturn(code);
  return `(async () => {\n${indentCode(body, 2)}\n})()`;
}

function maybeInjectImplicitReturn(code: string): string {
  const lines = code.split("\n");
  let index = lines.length - 1;
  while (index >= 0 && !lines[index]?.trim()) index -= 1;
  if (index < 0) return code;
  const target = lines[index].trim();
  if (!looksLikeExpressionStatement(target)) {
    return code;
  }
  const leading = /^\s*/.exec(lines[index])?.[0] ?? "";
  const expression = target.replace(/;\s*$/, "");
  lines[index] = `${leading}return ${expression};`;
  return lines.join("\n");
}

function looksLikeExpressionStatement(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("//") || line.startsWith("/*") || line === "{" || line === "}") return false;
  if (/^(const|let|var|if|for|while|switch|try|catch|finally|function|class|return|throw|import|export)\b/.test(line)) {
    return false;
  }
  return true;
}

function indentCode(code: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return code
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
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

  const googleSchemaFn = vm.newAsyncifiedFunction("__host_google_schema", async (argsHandle) => {
    bumpHostCall(stats, limits.execMaxHostCalls);
    const args = safeJsonParse(vm.getString(argsHandle));
    if (!args || typeof args !== "object") {
      throw new Error("google.schema requires payload object");
    }
    const payload = args as Record<string, unknown>;
    const service = String(payload.service ?? "").trim();
    const version = String(payload.version ?? "").trim();
    const method = String(payload.method ?? "").trim();
    const schema = await getGoogleMethodSchema(service, version, method, ctx, stats);
    return vm.newString(JSON.stringify(schema));
  });
  vm.setProp(vm.global, "__host_google_schema", googleSchemaFn);
  googleSchemaFn.dispose();

  const googleCallFn = vm.newAsyncifiedFunction("__host_google_call", async (argsHandle) => {
    bumpHostCall(stats, limits.execMaxHostCalls);
    const args = safeJsonParse(vm.getString(argsHandle));
    if (!args || typeof args !== "object") {
      throw new Error("google.execute requires payload object");
    }
    const payload = args as Record<string, unknown>;
    const service = String(payload.service ?? "").trim();
    const version = String(payload.version ?? "").trim();
    const method = String(payload.method ?? "").trim();
    const params =
      payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
        ? (payload.params as Record<string, unknown>)
        : {};
    const body = Object.prototype.hasOwnProperty.call(payload, "body") ? payload.body : undefined;
    const result = await executeGoogleMethod({ service, version, method, params, body }, ctx, stats);
    return vm.newString(JSON.stringify(result));
  });
  vm.setProp(vm.global, "__host_google_call", googleCallFn);
  googleCallFn.dispose();
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

const __googlePathProxy = (service, version, segments = []) =>
  new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === "schema") {
        return async () =>
          JSON.parse(
            await globalThis.__host_google_schema(
              JSON.stringify({ service, version, method: segments.join(".") }),
            ),
          );
      }
      return __googlePathProxy(service, version, [...segments, String(prop)]);
    },
    apply(_target, _thisArg, args) {
      const options = args[0] ?? {};
      const params = options && typeof options === "object" && options.params ? options.params : {};
      const body = options && typeof options === "object" && "body" in options ? options.body : undefined;
      return globalThis
        .__host_google_call(
          JSON.stringify({
            service,
            version,
            method: segments.join("."),
            params,
            body,
          }),
        )
        .then((value) => JSON.parse(value));
    },
  });

globalThis.google = {
  api: async (service, version = "v1") => __googlePathProxy(String(service), String(version)),
  schema: async (service, version, method) =>
    JSON.parse(
      await globalThis.__host_google_schema(
        JSON.stringify({ service: String(service), version: String(version), method: String(method) }),
      ),
    ),
  execute: async ({ service, version, method, params = {}, body }) =>
    JSON.parse(
      await globalThis.__host_google_call(
        JSON.stringify({
          service: String(service),
          version: String(version),
          method: String(method),
          params,
          body,
        }),
      ),
    ),
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

async function getGoogleMethodSchema(
  service: string,
  version: string,
  methodPath: string,
  ctx: HostContext,
  stats: HostStats,
): Promise<Record<string, unknown>> {
  assertGoogleCallAllowed(service, methodPath, ctx);
  const doc = await getGoogleDiscoveryDocument(service, version, stats);
  const method = findGoogleDiscoveryMethod(doc, methodPath);
  return {
    service,
    version,
    method: methodPath,
    httpMethod: method.httpMethod,
    path: method.path,
    parameters: method.parameters ?? {},
    request: method.request ?? null,
    response: method.response ?? null,
    description: method.description ?? "",
  };
}

async function executeGoogleMethod(
  input: {
    service: string;
    version: string;
    method: string;
    params: Record<string, unknown>;
    body: unknown;
  },
  ctx: HostContext,
  stats: HostStats,
): Promise<Record<string, unknown>> {
  assertGoogleCallAllowed(input.service, input.method, ctx);
  stats.googleCalls += 1;
  const doc = await getGoogleDiscoveryDocument(input.service, input.version, stats);
  const method = findGoogleDiscoveryMethod(doc, input.method);

  const params = { ...input.params };
  const path = expandGooglePathTemplate(method.path, params);
  const rootUrl = String(doc.rootUrl ?? "https://www.googleapis.com/");
  const servicePath = String(doc.servicePath ?? `${input.service}/${input.version}/`);
  const baseUrl = new URL(`${servicePath}${path}`, rootUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    baseUrl.searchParams.set(key, String(value));
  }

  if (!ctx.googleAuth) {
    throw new Error("Google API is not configured");
  }
  const auth = await ctx.googleAuth.getAccessToken();

  const response = await fetch(baseUrl.toString(), {
    method: method.httpMethod,
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "content-type": "application/json",
    },
    body: hasGoogleRequestBody(method.httpMethod) ? JSON.stringify(input.body ?? {}) : undefined,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const parsed = contentType.includes("application/json") ? safeJsonParse(text) : text;
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: baseUrl.toString(),
    method: method.httpMethod,
    result: parsed,
  };
}

function assertGoogleCallAllowed(service: string, methodPath: string, ctx: HostContext): void {
  const normalizedService = String(service ?? "").trim();
  const normalizedMethod = String(methodPath ?? "").trim();
  if (!normalizedService || !/^[a-z0-9-]+$/i.test(normalizedService)) {
    throw new Error("Google service is required");
  }
  if (!normalizedMethod || !/^[a-z0-9.]+$/i.test(normalizedMethod)) {
    throw new Error("Google method path is required");
  }
  const allowed = ctx.googleAuth?.allowedServices;
  if (allowed && allowed.length > 0 && !allowed.includes(normalizedService)) {
    throw new Error(`Google service '${normalizedService}' is not allowed`);
  }
}

async function getGoogleDiscoveryDocument(service: string, version: string, stats: HostStats): Promise<GoogleDiscoveryDoc> {
  const normalizedService = service.trim().toLowerCase();
  const normalizedVersion = version.trim().toLowerCase();
  if (!normalizedVersion) {
    throw new Error("Google API version is required");
  }
  const key = `${normalizedService}:${normalizedVersion}`;
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.doc;
  }

  const discoveryUrl = `https://www.googleapis.com/discovery/v1/apis/${encodeURIComponent(normalizedService)}/${encodeURIComponent(normalizedVersion)}/rest`;
  const response = await fetch(discoveryUrl, { method: "GET" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discovery fetch failed (${response.status}): ${truncate(body, 240)}`);
  }
  const doc = (await response.json()) as GoogleDiscoveryDoc;
  const methods = flattenGoogleDiscoveryMethods(doc.resources ?? {}, "");
  doc.methods = methods;
  discoveryCache.set(key, { expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS, doc });
  stats.discoveryFetches += 1;
  return doc;
}

function flattenGoogleDiscoveryMethods(resources: Record<string, unknown>, prefix: string): Record<string, GoogleDiscoveryMethod> {
  const out: Record<string, GoogleDiscoveryMethod> = {};
  for (const [resourceName, resourceValue] of Object.entries(resources)) {
    if (!resourceValue || typeof resourceValue !== "object") continue;
    const resource = resourceValue as Record<string, unknown>;
    const nextPrefix = prefix ? `${prefix}.${resourceName}` : resourceName;
    const methods = resource.methods as Record<string, unknown> | undefined;
    if (methods) {
      for (const [methodName, methodValue] of Object.entries(methods)) {
        if (!methodValue || typeof methodValue !== "object") continue;
        const method = methodValue as Record<string, unknown>;
        out[`${nextPrefix}.${methodName}`] = {
          methodPath: `${nextPrefix}.${methodName}`,
          httpMethod: String(method.httpMethod ?? "GET"),
          path: String(method.path ?? ""),
          parameters: (method.parameters as Record<string, unknown> | undefined) ?? {},
          request: method.request,
          response: method.response,
          description: typeof method.description === "string" ? method.description : undefined,
        };
      }
    }
    const nested = resource.resources as Record<string, unknown> | undefined;
    if (nested) {
      const deeper = flattenGoogleDiscoveryMethods(nested, nextPrefix);
      Object.assign(out, deeper);
    }
  }
  return out;
}

function findGoogleDiscoveryMethod(doc: GoogleDiscoveryDoc, methodPath: string): GoogleDiscoveryMethod {
  const methods = doc.methods ?? {};
  const method = methods[methodPath];
  if (!method) {
    throw new Error(`Unknown Google method: ${methodPath}`);
  }
  return method;
}

function expandGooglePathTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\+?)([^}]+)\}/g, (_match, plus, rawName: string) => {
    const value = params[rawName];
    if (value === undefined || value === null) {
      throw new Error(`Missing path parameter: ${rawName}`);
    }
    delete params[rawName];
    const source = String(value);
    if (plus === "+") {
      return source
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    }
    return encodeURIComponent(source);
  });
}

function hasGoogleRequestBody(httpMethod: string): boolean {
  const method = httpMethod.toUpperCase();
  return method === "POST" || method === "PUT" || method === "PATCH";
}

async function executeFetch(url: string, init: unknown, limits: CodeExecutionLimits, stats: HostStats): Promise<Record<string, unknown>> {
  await acquireFetchSlot(limits, stats);
  try {
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
  } finally {
    releaseFetchSlot(stats);
  }
}

function acquireFetchSlot(limits: CodeExecutionLimits, stats: HostStats): Promise<void> {
  if (stats.activeFetches < limits.netMaxParallel) {
    stats.activeFetches += 1;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = stats.fetchWaiters.indexOf(resume);
      if (index >= 0) stats.fetchWaiters.splice(index, 1);
      reject(new Error("fetch parallel limit wait timed out"));
    }, limits.netRequestTimeoutMs);

    const resume = () => {
      clearTimeout(timer);
      stats.activeFetches += 1;
      resolve();
    };
    stats.fetchWaiters.push(resume);
  });
}

function releaseFetchSlot(stats: HostStats): void {
  if (stats.activeFetches > 0) stats.activeFetches -= 1;
  const next = stats.fetchWaiters.shift();
  if (next) next();
}

async function flushAsyncWork(
  runtime: { hasPendingJob: () => boolean; executePendingJobs: (max?: number) => { error?: unknown } },
  stats: HostStats,
  deadline: number,
  maxJobs: number,
): Promise<void> {
  while (runtime.hasPendingJob() || stats.activeFetches > 0 || stats.fetchWaiters.length > 0) {
    if (Date.now() > deadline) {
      throw new Error("Execution timed out");
    }
    runPendingJobs(runtime, maxJobs);
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function bumpHostCall(stats: HostStats, _maxHostCalls: number): void {
  stats.hostCalls += 1;
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
  return newQuickJSAsyncWASMModuleFromVariant(
    newVariant(QUICKJS_ASYNC_WASMFILE_VARIANT, {
      wasmModule: QUICKJS_ASYNC_WASM_MODULE,
    }),
  );
}

async function setGlobalJson(vm: QuickJsContext, key: string, value: unknown): Promise<void> {
  const handle = vm.newString(JSON.stringify(value));
  vm.setProp(vm.global, key, handle);
  handle.dispose();
  const parseResult = await vm.evalCodeAsync(`globalThis.${key} = JSON.parse(globalThis.${key});`);
  vm.unwrapResult(parseResult).dispose();
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
