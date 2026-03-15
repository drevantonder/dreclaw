import type { Env } from "../../cloudflare/env";
import { createGooglePlugin } from "../../plugins/google";
import type { CorePlugin } from "./types";

export function createPluginRegistry(env: Env) {
  const plugins = [createGooglePlugin(env)];
  return new PluginRegistry(plugins);
}

export class PluginRegistry {
  constructor(private readonly plugins: CorePlugin[]) {}

  list(): CorePlugin[] {
    return [...this.plugins];
  }

  listCommands() {
    return this.plugins.flatMap((plugin) => plugin.commands ?? []);
  }

  getOAuthCallbackHandler(name: string) {
    const plugin = this.plugins.find((item) => item.name === name);
    if (!plugin?.handleOAuthCallback) return undefined;
    return (request: Request) => plugin.handleOAuthCallback!(request);
  }

  getByName(name: string) {
    return this.plugins.find((plugin) => plugin.name === name) ?? null;
  }
}
