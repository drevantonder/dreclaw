export interface MemoryDeps {
  db: D1Database;
  aiBinding?: Ai;
  vectorIndex?: VectorizeIndex;
  settings: {
    enabled?: string;
    retentionDays?: string;
    maxInjectTokens?: string;
    reflectionEveryTurns?: string;
    embeddingModel?: string;
  };
}
