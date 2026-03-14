import { WorkerEntrypoint } from "cloudflare:workers";
import { deleteVfsEntry, getVfsEntry, listVfsEntries, putVfsEntry } from "./db";
import { decodeEncryptionKey, decryptSecret } from "./crypto";
import { getGoogleOAuthToken } from "./db";
import { getGoogleOAuthConfig, refreshGoogleAccessToken } from "./google-oauth";
import { executeMemoryFind, executeMemoryRemove, executeMemorySave } from "./memory/execute-api";
import { getMemoryConfig } from "./memory/config";
import type { Env } from "./types";

const GOOGLE_OAUTH_DEFAULT_PRINCIPAL = "default";
const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const discoveryCache = new Map<string, { expiresAt: number; doc: GoogleDiscoveryDoc }>();

export interface ExecuteHostProps {
  chatId: number;
  threadId: string;
  limits: {
    execMaxOutputBytes: number;
    execMaxLogLines: number;
    netRequestTimeoutMs: number;
    netMaxResponseBytes: number;
    vfsMaxFileBytes: number;
    vfsListLimit: number;
  };
  allowedGoogleServices: string[];
}

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

type ExecuteHostCall =
  | { action: "fs.read"; path: string }
  | { action: "fs.write"; path: string; content: string; overwrite?: boolean }
  | { action: "fs.list"; prefix?: string }
  | { action: "fs.remove"; path: string }
  | { action: "memory.find"; payload: unknown }
  | { action: "memory.save"; payload: unknown }
  | { action: "memory.remove"; payload: unknown }
  | {
      action: "fetch";
      request: {
        url: string;
        method?: string;
        headers?: Array<[string, string]>;
        bodyBase64?: string | null;
      };
    }
  | {
      action: "google.execute";
      payload: {
        service?: string;
        version?: string;
        method?: string;
        params?: Record<string, unknown>;
        body?: unknown;
      };
    };

export class ExecuteHost extends WorkerEntrypoint<Env, ExecuteHostProps> {
  async call(input: ExecuteHostCall): Promise<unknown> {
    switch (input.action) {
      case "fs.read":
        return this.readVfsContent(input.path);
      case "fs.write":
        return this.writeVfsContent(input.path, input.content, Boolean(input.overwrite));
      case "fs.list":
        return this.listVfsPaths(input.prefix ?? "/");
      case "fs.remove":
        return this.deleteVfsContent(input.path);
      case "memory.find":
        return this.executeMemoryFindPayload(input.payload);
      case "memory.save":
        return this.executeMemorySavePayload(input.payload);
      case "memory.remove":
        return this.executeMemoryRemovePayload(input.payload);
      case "fetch":
        return this.executeFetch(input.request);
      case "google.execute":
        return this.executeGoogle(input.payload);
      default:
        throw new Error("EXECUTE_HOST_UNSUPPORTED_ACTION");
    }
  }

  private props(): ExecuteHostProps {
    return (this.ctx.props ?? {}) as ExecuteHostProps;
  }

  private normalizeVfsPath(path: string): string {
    const input = String(path ?? "").trim();
    if (!input) throw new Error("VFS_INVALID_PATH: path is required");
    const value = input.startsWith("vfs:/") ? input.slice(4) : input;
    if (!value.startsWith("/")) throw new Error("VFS_INVALID_PATH: path must be absolute");
    const normalized: string[] = [];
    for (const part of value.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!normalized.length) throw new Error("VFS_INVALID_PATH: path traversal is not allowed");
        normalized.pop();
        continue;
      }
      if (part.includes("\\")) throw new Error("VFS_INVALID_PATH: invalid separator");
      normalized.push(part);
    }
    return `/${normalized.join("/")}`;
  }

  private async readVfsContent(path: string): Promise<string | null> {
    const entry = await getVfsEntry(this.env.DRECLAW_DB, this.normalizeVfsPath(path));
    return entry?.content ?? null;
  }

  private async writeVfsContent(path: string, content: string, overwrite: boolean) {
    const normalized = this.normalizeVfsPath(path);
    if (normalized.startsWith("/skills/system/"))
      return { ok: false as const, code: "VFS_READ_ONLY" as const };
    const sizeBytes = new TextEncoder().encode(content).byteLength;
    if (sizeBytes > this.props().limits.vfsMaxFileBytes) {
      return { ok: false as const, code: "VFS_LIMIT_EXCEEDED" as const };
    }
    const nowIso = new Date().toISOString();
    const result = await putVfsEntry(this.env.DRECLAW_DB, {
      path: normalized,
      content,
      sizeBytes,
      sha256: await sha256Hex(content),
      nowIso,
      overwrite,
    });
    return result.ok
      ? { ok: true as const, path: normalized }
      : { ok: false as const, code: result.code };
  }

  private async listVfsPaths(prefix: string): Promise<string[]> {
    const rows = await listVfsEntries(
      this.env.DRECLAW_DB,
      this.normalizeVfsPath(prefix || "/"),
      Math.max(1, this.props().limits.vfsListLimit),
    );
    return rows.map((row) => row.path);
  }

  private async deleteVfsContent(path: string): Promise<boolean> {
    const normalized = this.normalizeVfsPath(path);
    if (normalized.startsWith("/skills/system/")) return false;
    return deleteVfsEntry(this.env.DRECLAW_DB, normalized, new Date().toISOString());
  }

  private async executeMemoryFindPayload(payload: unknown): Promise<unknown> {
    const memory = getMemoryConfig(this.env);
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemoryFind({
      env: this.env,
      db: this.env.DRECLAW_DB,
      chatId: this.props().chatId,
      embeddingModel: memory.embeddingModel,
      payload,
    });
  }

  private async executeMemorySavePayload(payload: unknown): Promise<unknown> {
    const memory = getMemoryConfig(this.env);
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemorySave({
      env: this.env,
      db: this.env.DRECLAW_DB,
      chatId: this.props().chatId,
      embeddingModel: memory.embeddingModel,
      payload,
    });
  }

  private async executeMemoryRemovePayload(payload: unknown): Promise<unknown> {
    const memory = getMemoryConfig(this.env);
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemoryRemove({
      env: this.env,
      db: this.env.DRECLAW_DB,
      chatId: this.props().chatId,
      payload,
    });
  }

  private async executeFetch(request: {
    url: string;
    method?: string;
    headers?: Array<[string, string]>;
    bodyBase64?: string | null;
  }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.props().limits.netRequestTimeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method || "GET",
        headers: request.headers ?? [],
        body: request.bodyBase64 ? new Blob([decodeBase64(request.bodyBase64)]) : undefined,
        signal: controller.signal,
      });
      const body = await response.arrayBuffer();
      if (body.byteLength > this.props().limits.netMaxResponseBytes) {
        throw new Error("FETCH_RESPONSE_TOO_LARGE");
      }
      return {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: collectHeaders(response.headers),
        bodyBase64: encodeBase64(body),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async executeGoogle(payload: {
    service?: string;
    version?: string;
    method?: string;
    params?: Record<string, unknown>;
    body?: unknown;
  }): Promise<unknown> {
    const service = String(payload.service ?? "")
      .trim()
      .toLowerCase();
    if (!service) throw new Error("GOOGLE_SERVICE_REQUIRED");
    if (!this.props().allowedGoogleServices.includes(service))
      throw new Error(`GOOGLE_SERVICE_NOT_ALLOWED: ${service}`);
    const token = await this.getGoogleAccessToken();
    const version = String(payload.version ?? "").trim();
    const method = String(payload.method ?? "").trim();
    if (!version || !method) throw new Error("GOOGLE_METHOD_REQUIRED");
    const discovery = await getGoogleDiscoveryDocument(
      service,
      version,
      this.props().limits.netRequestTimeoutMs,
    );
    const methodInfo = findGoogleDiscoveryMethod(discovery, method);
    const params = { ...payload.params };
    const path = expandGooglePathTemplate(methodInfo.path, params);
    const url = new URL(
      `${String(discovery.servicePath ?? `${service}/${version}/`)}${path}`,
      String(discovery.rootUrl ?? "https://www.googleapis.com/"),
    );
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    const response = await fetch(url.toString(), {
      method: methodInfo.httpMethod,
      headers: {
        authorization: `Bearer ${token.accessToken}`,
        ...(hasGoogleRequestBody(methodInfo.httpMethod)
          ? { "content-type": "application/json" }
          : {}),
      },
      body: hasGoogleRequestBody(methodInfo.httpMethod)
        ? JSON.stringify(payload.body ?? {})
        : undefined,
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      result: text ? safeJsonParse(text) : null,
    };
  }

  private async getGoogleAccessToken(): Promise<{ accessToken: string; scope: string }> {
    const token = await getGoogleOAuthToken(this.env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
    if (!token) throw new Error("Google account not linked. Run /google connect");
    const refreshToken = await decryptSecret(
      { ciphertext: token.refreshTokenCiphertext, nonce: token.nonce },
      decodeEncryptionKey(String(this.env.GOOGLE_OAUTH_ENCRYPTION_KEY ?? "")),
    );
    const refreshed = await refreshGoogleAccessToken(
      getGoogleOAuthConfig(this.env),
      refreshToken,
      this.props().limits.netRequestTimeoutMs,
    );
    return { accessToken: refreshed.accessToken, scope: refreshed.scope };
  }
}

async function getGoogleDiscoveryDocument(
  service: string,
  version: string,
  timeoutMs: number,
): Promise<GoogleDiscoveryDoc> {
  const key = `${service}:${version}`;
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/discovery/v1/apis/${encodeURIComponent(service)}/${encodeURIComponent(version)}/rest`,
    timeoutMs,
    { method: "GET" },
  );
  if (!response.ok) throw new Error(`GOOGLE_DISCOVERY_FAILED: ${response.status}`);
  const doc = (await response.json()) as GoogleDiscoveryDoc;
  doc.methods = flattenGoogleDiscoveryMethods(doc.resources ?? {}, "");
  discoveryCache.set(key, { expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS, doc });
  return doc;
}

function flattenGoogleDiscoveryMethods(
  resources: Record<string, unknown>,
  prefix: string,
): Record<string, GoogleDiscoveryMethod> {
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
    if (nested) Object.assign(out, flattenGoogleDiscoveryMethods(nested, nextPrefix));
  }
  return out;
}

function findGoogleDiscoveryMethod(
  doc: GoogleDiscoveryDoc,
  methodPath: string,
): GoogleDiscoveryMethod {
  const method = doc.methods?.[methodPath];
  if (!method) throw new Error(`GOOGLE_METHOD_UNKNOWN: ${methodPath}`);
  return method;
}

function expandGooglePathTemplate(template: string, params: Record<string, unknown>): string {
  return String(template).replace(/\{(\+?)([^}]+)\}/g, (_match, plus: string, name: string) => {
    const value = params[name];
    if (value === undefined || value === null)
      throw new Error(`GOOGLE_PATH_PARAM_MISSING: ${name}`);
    delete params[name];
    const source = String(value);
    if (plus === "+")
      return source
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    return encodeURIComponent(source);
  });
}

function hasGoogleRequestBody(httpMethod: string): boolean {
  const method = httpMethod.toUpperCase();
  return method === "POST" || method === "PUT" || method === "PATCH";
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function collectHeaders(headers: Headers): Array<[string, string]> {
  const values: Array<[string, string]> = [];
  headers.forEach((value, key) => {
    values.push([key, value]);
  });
  return values;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function encodeBase64(input: ArrayBuffer): string {
  let output = "";
  for (const value of new Uint8Array(input)) output += String.fromCharCode(value);
  return btoa(output);
}

function decodeBase64(input: string): ArrayBuffer {
  const raw = atob(input);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output.buffer as ArrayBuffer;
}
