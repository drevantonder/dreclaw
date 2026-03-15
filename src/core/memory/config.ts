import type { MemoryDeps } from "./types";

export interface MemoryConfig {
  enabled: boolean;
  retentionDays: number;
  maxInjectTokens: number;
  reflectionEveryTurns: number;
  embeddingModel: string;
}

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_INJECT_TOKENS = 1500;
const DEFAULT_REFLECTION_EVERY_TURNS = 8;
const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export function getMemoryConfig(deps: MemoryDeps | object): MemoryConfig {
  const normalized = normalizeMemoryDeps(deps);
  const enabled = parseBooleanFlag(normalized.settings.enabled, true);
  const config: MemoryConfig = {
    enabled,
    retentionDays: parsePositiveInt(
      normalized.settings.retentionDays,
      DEFAULT_RETENTION_DAYS,
      "MEMORY_RETENTION_DAYS",
    ),
    maxInjectTokens: parsePositiveInt(
      normalized.settings.maxInjectTokens,
      DEFAULT_MAX_INJECT_TOKENS,
      "MEMORY_MAX_INJECT_TOKENS",
    ),
    reflectionEveryTurns: parsePositiveInt(
      normalized.settings.reflectionEveryTurns,
      DEFAULT_REFLECTION_EVERY_TURNS,
      "MEMORY_REFLECTION_EVERY_TURNS",
    ),
    embeddingModel:
      String(normalized.settings.embeddingModel ?? "").trim() || DEFAULT_EMBEDDING_MODEL,
  };
  if (!enabled) return config;
  if (!normalized.aiBinding) {
    throw new Error("MEMORY_ENABLED=true requires AI binding for embeddings");
  }
  if (!normalized.vectorIndex) {
    throw new Error("MEMORY_ENABLED=true requires VECTORIZE_MEMORY binding");
  }
  return config;
}

function normalizeMemoryDeps(input: MemoryDeps | object): MemoryDeps {
  if (input && typeof input === "object" && "settings" in input) return input as MemoryDeps;
  const env = (input ?? {}) as Record<string, unknown>;
  return {
    db: (env.DRECLAW_DB ?? {}) as D1Database,
    aiBinding: env.AI as Ai | undefined,
    vectorIndex: env.VECTORIZE_MEMORY as VectorizeIndex | undefined,
    settings: {
      enabled: env.MEMORY_ENABLED as string | undefined,
      retentionDays: env.MEMORY_RETENTION_DAYS as string | undefined,
      maxInjectTokens: env.MEMORY_MAX_INJECT_TOKENS as string | undefined,
      reflectionEveryTurns: env.MEMORY_REFLECTION_EVERY_TURNS as string | undefined,
      embeddingModel: env.MEMORY_EMBEDDING_MODEL as string | undefined,
    },
  };
}

function parseBooleanFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null || raw.trim() === "") return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on")
    return true;
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off")
    return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

function parsePositiveInt(raw: string | undefined, defaultValue: number, name: string): number {
  if (raw === undefined || raw === null || raw.trim() === "") return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.trunc(value);
}
