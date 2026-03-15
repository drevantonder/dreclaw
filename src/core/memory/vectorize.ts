import type { MemoryDeps } from "./types";

export interface VectorMatch {
  id: string;
  score: number;
}

export async function upsertFactVector(
  vectorIndex: MemoryDeps["vectorIndex"],
  factId: string,
  chatId: number,
  values: number[],
): Promise<void> {
  if (!vectorIndex) throw new Error("VECTORIZE_MEMORY binding missing");
  const index = vectorIndex as unknown as {
    upsert: (
      items: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>,
    ) => Promise<unknown>;
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
  vectorIndex: MemoryDeps["vectorIndex"],
  chatId: number,
  values: number[],
  topK: number,
): Promise<VectorMatch[]> {
  if (!vectorIndex) throw new Error("VECTORIZE_MEMORY binding missing");
  const index = vectorIndex as unknown as {
    query: (
      vector: number[],
      options: {
        topK: number;
        filter?: Record<string, unknown>;
      },
    ) => Promise<{ matches?: Array<{ id?: string; score?: number }> }>;
  };
  const result = await index.query(values, {
    topK,
    filter: { chat_id: { $eq: chatId } },
  });
  const matches = result.matches ?? [];
  return matches
    .map((item) => ({ id: String(item.id ?? ""), score: Number(item.score ?? 0) }))
    .filter((item) => item.id && Number.isFinite(item.score));
}

export async function deleteFactVectors(
  vectorIndex: MemoryDeps["vectorIndex"],
  ids: string[],
): Promise<void> {
  if (!ids.length) return;
  if (!vectorIndex) throw new Error("VECTORIZE_MEMORY binding missing");
  const index = vectorIndex as unknown as {
    deleteByIds?: (ids: string[]) => Promise<unknown>;
  };
  if (typeof index.deleteByIds === "function") {
    await index.deleteByIds(ids);
  }
}
