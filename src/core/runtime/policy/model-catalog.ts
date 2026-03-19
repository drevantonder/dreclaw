export interface ModelCatalogEntry {
  alias: string;
  provider: "workers" | "opencode" | "opencode-go" | "fireworks";
  model: string;
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    alias: "glm",
    provider: "workers",
    model: "@cf/zai-org/glm-4.7-flash",
  },
  {
    alias: "workers-kimi",
    provider: "workers",
    model: "@cf/moonshotai/kimi-k2.5",
  },
  {
    alias: "kimi",
    provider: "opencode-go",
    model: "kimi-k2.5",
  },
  {
    alias: "fireworks-kimi",
    provider: "fireworks",
    model: "accounts/fireworks/models/kimi-k2p5",
  },
  {
    alias: "fireworks-minimax",
    provider: "fireworks",
    model: "accounts/fireworks/models/minimax-m2p5",
  },
];

export function getDefaultModelCatalogEntry(): ModelCatalogEntry {
  return MODEL_CATALOG[0];
}

export function findModelCatalogEntry(alias: string | null | undefined): ModelCatalogEntry | null {
  const normalized = String(alias ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return MODEL_CATALOG.find((entry) => entry.alias === normalized) ?? null;
}

export function listModelAliases(): string[] {
  return MODEL_CATALOG.map((entry) => entry.alias);
}
