import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  listUnprocessedMemoryEpisodes,
  markMemoryEpisodesProcessed,
  upsertSimilarMemoryFact,
  attachMemoryFactSource,
  scoreSalience,
  extractFacts,
} = vi.hoisted(() => ({
  listUnprocessedMemoryEpisodes: vi.fn(),
  markMemoryEpisodesProcessed: vi.fn(),
  upsertSimilarMemoryFact: vi.fn(),
  attachMemoryFactSource: vi.fn(),
  scoreSalience: vi.fn(),
  extractFacts: vi.fn(),
}));

vi.mock("../../src/core/memory/repo", () => ({
  listUnprocessedMemoryEpisodes,
  markMemoryEpisodesProcessed,
  upsertSimilarMemoryFact,
  attachMemoryFactSource,
}));
vi.mock("../../src/core/memory/salience", () => ({ scoreSalience, extractFacts }));

import { runMemoryReflection } from "../../src/core/memory/reflection";

describe("memory reflection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes facts from unprocessed episodes and marks them processed", async () => {
    listUnprocessedMemoryEpisodes.mockResolvedValue([{ id: "ep_1", content: "remember this" }]);
    scoreSalience.mockReturnValue({ shouldStoreFact: true });
    extractFacts.mockReturnValue([{ kind: "fact", text: "Remember this", confidence: 0.9 }]);
    upsertSimilarMemoryFact.mockResolvedValue({
      created: true,
      fact: { id: "fact_1" },
    });

    const result = await runMemoryReflection({
      db: {} as never,
      chatId: 777,
      limit: 10,
      nowIso: "2026-01-01T00:00:00.000Z",
    });

    expect(result).toEqual({ processedEpisodes: 1, writtenFacts: 1 });
    expect(attachMemoryFactSource).toHaveBeenCalledWith(
      expect.anything(),
      "fact_1",
      "ep_1",
      "2026-01-01T00:00:00.000Z",
    );
    expect(markMemoryEpisodesProcessed).toHaveBeenCalledWith(
      expect.anything(),
      ["ep_1"],
      "2026-01-01T00:00:00.000Z",
    );
  });
});
