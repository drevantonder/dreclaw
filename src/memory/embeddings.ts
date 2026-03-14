import type { Env } from "../types";

export async function embedText(env: Env, model: string, text: string): Promise<number[]> {
  const input = String(text ?? "").trim();
  if (!input) return [];
  if (!env.AI) throw new Error("AI binding missing for embeddings");

  const ai = env.AI as unknown as { run: (name: string, payload: unknown) => Promise<unknown> };
  const response = await ai.run(model, { text: [input] });
  const vector = extractEmbeddingVector(response);
  if (!vector.length) {
    throw new Error("Embedding model returned empty vector");
  }
  return vector;
}

function extractEmbeddingVector(payload: unknown): number[] {
  if (!payload || typeof payload !== "object") return [];
  const row = payload as Record<string, unknown>;

  if (Array.isArray(row.data) && row.data.length > 0) {
    const first = row.data[0];
    if (Array.isArray(first)) return first.map((value) => Number(value)).filter(Number.isFinite);
    if (
      first &&
      typeof first === "object" &&
      Array.isArray((first as Record<string, unknown>).embedding)
    ) {
      return ((first as Record<string, unknown>).embedding as unknown[])
        .map((value) => Number(value))
        .filter(Number.isFinite);
    }
  }

  if (Array.isArray(row.embedding)) {
    return (row.embedding as unknown[]).map((value) => Number(value)).filter(Number.isFinite);
  }

  if (Array.isArray(row.result) && row.result.length > 0 && Array.isArray(row.result[0])) {
    return (row.result[0] as unknown[]).map((value) => Number(value)).filter(Number.isFinite);
  }

  return [];
}
