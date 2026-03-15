import type { CorePlugin, PluginRegistry as PluginRegistryContract } from "./types";

export function createPluginRegistry(plugins: CorePlugin[]): PluginRegistry {
  return new PluginRegistry(plugins);
}

export class PluginRegistry implements PluginRegistryContract {
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
