import type { CorePlugin, PluginRegistry as PluginRegistryContract } from "./types";

export function createPluginRegistry(plugins: CorePlugin[]): PluginRegistry {
  return new PluginRegistry(plugins);
}

export class PluginRegistry implements PluginRegistryContract {
  constructor(private readonly plugins: CorePlugin[]) {
    const names = new Set<string>();
    const tables = new Set<string>();
    for (const plugin of plugins) {
      if (names.has(plugin.name)) throw new Error(`Duplicate plugin name: ${plugin.name}`);
      names.add(plugin.name);
      for (const table of plugin.ownedTables ?? []) {
        if (tables.has(table)) throw new Error(`Duplicate plugin-owned table: ${table}`);
        tables.add(table);
      }
    }
  }

  list(): CorePlugin[] {
    return [...this.plugins];
  }

  listCommands() {
    return this.plugins.flatMap((plugin) => plugin.commands ?? []);
  }

  async runScheduled(ctx: { nowIso: string }) {
    for (const plugin of this.plugins) {
      if (!plugin.onScheduled) continue;
      await plugin.onScheduled(ctx);
    }
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
