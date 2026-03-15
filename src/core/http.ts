import type { Env } from "../cloudflare/env";
import { createPluginRegistry } from "./plugins/registry";

export function getHealthPayload() {
  return { ok: true, service: "dreclaw", ts: Date.now() };
}

export async function handlePluginOAuthCallback(env: Env, pluginName: string, request: Request) {
  const handler = createPluginRegistry(env).getOAuthCallbackHandler(pluginName);
  if (!handler) return null;
  return handler(request);
}
