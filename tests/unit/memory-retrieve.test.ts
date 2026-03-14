import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  embedText,
  queryFactVectors,
  listMemoryFactsByIds,
  searchMemoryFactsKeyword,
  listRecentMemoryEpisodes,
} = vi.hoisted(() => ({
  embedText: vi.fn(),
  queryFactVectors: vi.fn(),
  listMemoryFactsByIds: vi.fn(),
  searchMemoryFactsKeyword: vi.fn(),
  listRecentMemoryEpisodes: vi.fn(),
}));

vi.mock("../../src/memory/embeddings", () => ({ embedText }));
vi.mock("../../src/memory/vectorize", () => ({ queryFactVectors }));
vi.mock("../../src/memory/repo", () => ({
  listMemoryFactsByIds,
  searchMemoryFactsKeyword,
  listRecentMemoryEpisodes,
}));

import { retrieveMemoryContext } from "../../src/memory/retrieve";

describe("memory retrieve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("combines vector, keyword, and recent episode results", async () => {
    embedText.mockResolvedValue([0.1, 0.2]);
    searchMemoryFactsKeyword.mockResolvedValue([
      {
        id: "fact_keyword",
        kind: "fact",
        text: "Keyword fact",
        confidence: 0.8,
        updatedAt: new Date().toISOString(),
      },
    ]);
    listRecentMemoryEpisodes.mockResolvedValue([{ role: "user", content: "recent note" }]);
    queryFactVectors.mockResolvedValue([{ id: "fact_vector", score: 0.9 }]);
    listMemoryFactsByIds.mockResolvedValue([
      {
        id: "fact_vector",
        kind: "preference",
        text: "Vector fact",
        confidence: 0.9,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const result = await retrieveMemoryContext({
      env: {} as never,
      db: {} as never,
      chatId: 777,
      query: "concise replies",
      embeddingModel: "model",
      factTopK: 3,
      episodeTopK: 2,
    });

    expect(embedText).toHaveBeenCalledWith(expect.anything(), "model", "concise replies");
    expect(queryFactVectors).toHaveBeenCalledWith(expect.anything(), 777, [0.1, 0.2], 9);
    expect(result.facts.map((fact) => fact.id)).toEqual(["fact_vector", "fact_keyword"]);
    expect(result.episodes).toEqual([{ role: "user", content: "recent note" }]);
  });
});
