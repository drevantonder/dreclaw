import type { Env } from "../../cloudflare/env";
import {
  expandGooglePathTemplate,
  findGoogleDiscoveryMethod,
  getGoogleDiscoveryDocument,
  hasGoogleRequestBody,
  safeJsonParse,
} from "./discovery";
import { getGoogleAccessToken } from "./client";

export async function executeGoogleRequest(
  env: Env,
  payload: {
    service?: string;
    version?: string;
    method?: string;
    params?: Record<string, unknown>;
    body?: unknown;
  },
  options: { allowedServices: string[]; timeoutMs: number },
): Promise<unknown> {
  const service = String(payload.service ?? "")
    .trim()
    .toLowerCase();
  if (!service) throw new Error("GOOGLE_SERVICE_REQUIRED");
  if (!options.allowedServices.includes(service)) {
    throw new Error(`GOOGLE_SERVICE_NOT_ALLOWED: ${service}`);
  }
  const version = String(payload.version ?? "").trim();
  const method = String(payload.method ?? "").trim();
  if (!version || !method) throw new Error("GOOGLE_METHOD_REQUIRED");
  const token = await getGoogleAccessToken(env, options.timeoutMs);
  const discovery = await getGoogleDiscoveryDocument(service, version, options.timeoutMs);
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
      for (const item of value) url.searchParams.append(key, formatQueryValue(item));
      continue;
    }
    url.searchParams.set(key, formatQueryValue(value));
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

function formatQueryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol") return value.description ?? "Symbol";
  return JSON.stringify(value);
}
