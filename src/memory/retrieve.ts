import { listMemoryFactsByIds, listRecentMemoryEpisodes, searchMemoryFactsKeyword, type MemoryFactRecord } from "../db";
import type { Env } from "../types";
import { embedText } from "./embeddings";
import { applyTemporalDecay } from "./decay";
import { queryFactVectors } from "./vectorize";

export interface RetrievedMemory {
  facts: MemoryFactRecord[];
  episodes: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
}

export async function retrieveMemoryContext(params: {
  env: Env;
  db: D1Database;
  chatId: number;
  query: string;
  embeddingModel: string;
  factTopK: number;
  episodeTopK: number;
}): Promise<RetrievedMemory> {
  const [queryEmbedding, keywordFacts, recentEpisodes] = await Promise.all([
    embedText(params.env, params.embeddingModel, params.query),
    searchMemoryFactsKeyword(params.db, params.chatId, buildKeywordQuery(params.query), params.factTopK * 2),
    listRecentMemoryEpisodes(params.db, params.chatId, params.episodeTopK),
  ]);

  const vectorMatches = await queryFactVectors(params.env, params.chatId, queryEmbedding, params.factTopK * 3);
  const vectorFactIds = unique(vectorMatches.map((item) => item.id));
  const vectorFacts = await listMemoryFactsByIds(params.db, params.chatId, vectorFactIds);

  const vectorScore = new Map<string, number>();
  for (const match of vectorMatches) vectorScore.set(match.id, Math.max(0, Math.min(1, match.score)));

  const keywordScore = new Map<string, number>();
  for (const [index, fact] of keywordFacts.entries()) {
    const rankScore = 1 - index / Math.max(1, keywordFacts.length);
    keywordScore.set(fact.id, rankScore);
  }

  const candidates = new Map<string, MemoryFactRecord>();
  for (const fact of vectorFacts) candidates.set(fact.id, fact);
  for (const fact of keywordFacts) candidates.set(fact.id, fact);

  const scored = [...candidates.values()].map((fact) => {
    const semantic = vectorScore.get(fact.id) ?? 0;
    const lexical = keywordScore.get(fact.id) ?? 0;
    const recency = applyTemporalDecay(1, fact.updatedAt);
    const finalScore = semantic * 0.55 + lexical * 0.25 + recency * 0.2;
    return { fact, finalScore };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const top = scored.slice(0, params.factTopK).map((item) => item.fact);

  return {
    facts: top,
    episodes: recentEpisodes.map((episode) => ({ role: episode.role, content: episode.content })),
  };
}

function buildKeywordQuery(input: string): string {
  const tokens = String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 6);
  if (!tokens.length) return "";
  return tokens.join(" OR ");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
