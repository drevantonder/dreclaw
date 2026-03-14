import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  getMemoryConfig,
  executeMemoryFind,
  executeMemorySave,
  executeMemoryRemove,
  retrieveMemoryContext,
  insertMemoryEpisode,
  upsertSimilarMemoryFact,
  attachMemoryFactSource,
  runMemoryReflection,
  listActiveMemoryFacts,
  deleteMemoryForChat,
  deleteOldMemoryEpisodes,
  embedText,
  upsertFactVector,
  deleteFactVectors,
  scoreSalience,
  extractFacts,
} = vi.hoisted(() => ({
  getMemoryConfig: vi.fn(),
  executeMemoryFind: vi.fn(),
  executeMemorySave: vi.fn(),
  executeMemoryRemove: vi.fn(),
  retrieveMemoryContext: vi.fn(),
  insertMemoryEpisode: vi.fn(),
  upsertSimilarMemoryFact: vi.fn(),
  attachMemoryFactSource: vi.fn(),
  runMemoryReflection: vi.fn(),
  listActiveMemoryFacts: vi.fn(),
  deleteMemoryForChat: vi.fn(),
  deleteOldMemoryEpisodes: vi.fn(),
  embedText: vi.fn(),
  upsertFactVector: vi.fn(),
  deleteFactVectors: vi.fn(),
  scoreSalience: vi.fn(),
  extractFacts: vi.fn(),
}));

vi.mock("../../src/memory/config", () => ({ getMemoryConfig }));
vi.mock("../../src/memory/execute-api", () => ({
  executeMemoryFind,
  executeMemorySave,
  executeMemoryRemove,
}));
vi.mock("../../src/memory/retrieve", () => ({ retrieveMemoryContext }));
vi.mock("../../src/memory/repo", () => ({
  insertMemoryEpisode,
  upsertSimilarMemoryFact,
  attachMemoryFactSource,
  listActiveMemoryFacts,
  deleteMemoryForChat,
  deleteOldMemoryEpisodes,
}));
vi.mock("../../src/memory/reflection", () => ({ runMemoryReflection }));
vi.mock("../../src/memory/embeddings", () => ({ embedText }));
vi.mock("../../src/memory/vectorize", () => ({ upsertFactVector, deleteFactVectors }));
vi.mock("../../src/memory/salience", () => ({ scoreSalience, extractFacts }));

import { createMemoryRuntime } from "../../src/memory";

describe("memory facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMemoryConfig.mockReturnValue({
      enabled: true,
      retentionDays: 90,
      maxInjectTokens: 100,
      reflectionEveryTurns: 2,
      embeddingModel: "model",
    });
    scoreSalience.mockReturnValue({ shouldStoreEpisode: true, shouldStoreFact: true, score: 0.9 });
    extractFacts.mockReturnValue([
      { kind: "preference", text: "User prefers bullets", confidence: 0.9 },
    ]);
  });

  it("delegates find to execute api with resolved config", async () => {
    executeMemoryFind.mockResolvedValue({ ok: true });
    const memory = createMemoryRuntime({ DRECLAW_DB: {} as D1Database } as never);

    const result = await memory.find({ chatId: 777, payload: { query: "abc" } });

    expect(executeMemoryFind).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 777, embeddingModel: "model", payload: { query: "abc" } }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("renders memory context and truncates to config budget", async () => {
    retrieveMemoryContext.mockResolvedValue({
      facts: [{ kind: "fact", text: "A".repeat(500) }],
      episodes: [{ role: "user", content: "B".repeat(500) }],
    });
    const memory = createMemoryRuntime({ DRECLAW_DB: {} as D1Database } as never);

    const text = await memory.renderContext({ chatId: 1, query: "q", factTopK: 2, episodeTopK: 1 });

    expect(retrieveMemoryContext).toHaveBeenCalled();
    expect(text.length).toBeLessThanOrEqual(402);
  });

  it("persists a turn and syncs vectors", async () => {
    upsertSimilarMemoryFact.mockResolvedValue({
      created: true,
      fact: { id: "fact_1", text: "User prefers bullets" },
    });
    embedText.mockResolvedValue([0.1, 0.2]);
    runMemoryReflection.mockResolvedValue({ writtenFacts: 0 });
    const memory = createMemoryRuntime({ DRECLAW_DB: {} as D1Database } as never);

    await memory.persistTurn({
      chatId: 777,
      userText: "Remember that I prefer bullet points.",
      assistantText: "ok",
      toolTranscripts: [],
      memoryTurns: 0,
    });

    expect(insertMemoryEpisode).toHaveBeenCalled();
    expect(attachMemoryFactSource).toHaveBeenCalled();
    expect(upsertFactVector).toHaveBeenCalledWith(expect.anything(), "fact_1", 777, [0.1, 0.2]);
    expect(deleteOldMemoryEpisodes).toHaveBeenCalled();
  });

  it("factory reset removes stored facts and vectors", async () => {
    listActiveMemoryFacts.mockResolvedValue([{ id: "fact_1" }, { id: "fact_2" }]);
    const memory = createMemoryRuntime({ DRECLAW_DB: {} as D1Database } as never);

    await memory.factoryReset({ chatId: 777 });

    expect(deleteMemoryForChat).toHaveBeenCalledWith(expect.anything(), 777);
    expect(deleteFactVectors).toHaveBeenCalledWith(expect.anything(), ["fact_1", "fact_2"]);
  });
});
