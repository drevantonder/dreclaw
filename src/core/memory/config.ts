import type { Env } from "../../types";

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

export function getMemoryConfig(env: Env): MemoryConfig {
  const enabled = parseBooleanFlag(env.MEMORY_ENABLED, true);
  const config: MemoryConfig = {
    enabled,
    retentionDays: parsePositiveInt(
      env.MEMORY_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
      "MEMORY_RETENTION_DAYS",
    ),
    maxInjectTokens: parsePositiveInt(
      env.MEMORY_MAX_INJECT_TOKENS,
      DEFAULT_MAX_INJECT_TOKENS,
      "MEMORY_MAX_INJECT_TOKENS",
    ),
    reflectionEveryTurns: parsePositiveInt(
      env.MEMORY_REFLECTION_EVERY_TURNS,
      DEFAULT_REFLECTION_EVERY_TURNS,
      "MEMORY_REFLECTION_EVERY_TURNS",
    ),
    embeddingModel: String(env.MEMORY_EMBEDDING_MODEL ?? "").trim() || DEFAULT_EMBEDDING_MODEL,
  };
  if (!enabled) return config;
  if (!env.AI) {
    throw new Error("MEMORY_ENABLED=true requires AI binding for embeddings");
  }
  if (!env.VECTORIZE_MEMORY) {
    throw new Error("MEMORY_ENABLED=true requires VECTORIZE_MEMORY binding");
  }
  return config;
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
