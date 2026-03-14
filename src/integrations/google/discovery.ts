const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const discoveryCache = new Map<string, { expiresAt: number; doc: GoogleDiscoveryDoc }>();

export type GoogleDiscoveryMethod = {
  methodPath: string;
  httpMethod: string;
  path: string;
  parameters?: Record<string, unknown>;
  request?: unknown;
  response?: unknown;
  description?: string;
};

export type GoogleDiscoveryDoc = {
  rootUrl?: string;
  servicePath?: string;
  methods?: Record<string, GoogleDiscoveryMethod>;
  resources?: Record<string, unknown>;
};

export async function getGoogleDiscoveryDocument(
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

export function findGoogleDiscoveryMethod(
  doc: GoogleDiscoveryDoc,
  methodPath: string,
): GoogleDiscoveryMethod {
  const method = doc.methods?.[methodPath];
  if (!method) throw new Error(`GOOGLE_METHOD_UNKNOWN: ${methodPath}`);
  return method;
}

export function expandGooglePathTemplate(
  template: string,
  params: Record<string, unknown>,
): string {
  return String(template).replace(/\{(\+?)([^}]+)\}/g, (_match, plus: string, name: string) => {
    const value = params[name];
    if (value === undefined || value === null)
      throw new Error(`GOOGLE_PATH_PARAM_MISSING: ${name}`);
    delete params[name];
    const source = formatQueryValue(value);
    if (plus === "+") {
      return source
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
    }
    return encodeURIComponent(source);
  });
}

export function hasGoogleRequestBody(httpMethod: string): boolean {
  const method = httpMethod.toUpperCase();
  return method === "POST" || method === "PUT" || method === "PATCH";
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
          httpMethod: typeof method.httpMethod === "string" ? method.httpMethod : "GET",
          path: typeof method.path === "string" ? method.path : "",
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

function formatQueryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol") return value.description ?? "Symbol";
  return JSON.stringify(value);
}
