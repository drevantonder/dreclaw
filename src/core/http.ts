import type { PluginRegistry } from "./plugins/types";

export function getHealthPayload() {
  return { ok: true, service: "dreclaw", ts: Date.now() };
}

export async function handlePluginOAuthCallback(
  pluginRegistry: PluginRegistry,
  pluginName: string,
  request: Request,
) {
  const handler = pluginRegistry.getOAuthCallbackHandler(pluginName);
  if (!handler) return null;
  return handler(request);
}
