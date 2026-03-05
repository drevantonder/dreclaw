import type { Env } from "../types";

export interface VectorMatch {
  id: string;
  score: number;
}

export async function upsertFactVector(env: Env, factId: string, chatId: number, values: number[]): Promise<void> {
  if (!env.VECTORIZE_MEMORY) throw new Error("VECTORIZE_MEMORY binding missing");
  const index = env.VECTORIZE_MEMORY as unknown as {
    upsert: (items: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) => Promise<unknown>;
  };
  await index.upsert([
    {
      id: factId,
      values,
      metadata: { chat_id: chatId },
    },
  ]);
}

export async function queryFactVectors(
  env: Env,
  chatId: number,
  values: number[],
  topK: number,
): Promise<VectorMatch[]> {
  if (!env.VECTORIZE_MEMORY) throw new Error("VECTORIZE_MEMORY binding missing");
  const index = env.VECTORIZE_MEMORY as unknown as {
    query: (
      vector: number[],
      options: {
        topK: number;
        filter?: Record<string, unknown>;
        returnMetadata?: boolean;
      },
    ) => Promise<{ matches?: Array<{ id?: string; score?: number }> }>;
  };
  const result = await index.query(values, {
    topK,
    filter: { chat_id: { $eq: chatId } },
    returnMetadata: false,
  });
  const matches = result.matches ?? [];
  return matches
    .map((item) => ({ id: String(item.id ?? ""), score: Number(item.score ?? 0) }))
    .filter((item) => item.id && Number.isFinite(item.score));
}

export async function deleteFactVectors(env: Env, ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (!env.VECTORIZE_MEMORY) throw new Error("VECTORIZE_MEMORY binding missing");
  const index = env.VECTORIZE_MEMORY as unknown as {
    deleteByIds?: (ids: string[]) => Promise<unknown>;
  };
  if (typeof index.deleteByIds === "function") {
    await index.deleteByIds(ids);
  }
}
