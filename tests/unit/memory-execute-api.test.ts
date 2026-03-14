import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  retrieveMemoryContext,
  embedText,
  upsertFactVector,
  deleteFactVectors,
  upsertSimilarMemoryFact,
  listActiveMemoryFacts,
  getActiveMemoryFactByTarget,
  deleteMemoryFactById,
} = vi.hoisted(() => ({
  retrieveMemoryContext: vi.fn(),
  embedText: vi.fn(),
  upsertFactVector: vi.fn(),
  deleteFactVectors: vi.fn(),
  upsertSimilarMemoryFact: vi.fn(),
  listActiveMemoryFacts: vi.fn(),
  getActiveMemoryFactByTarget: vi.fn(),
  deleteMemoryFactById: vi.fn(),
}));

vi.mock("../../src/memory/retrieve", () => ({ retrieveMemoryContext }));
vi.mock("../../src/memory/embeddings", () => ({ embedText }));
vi.mock("../../src/memory/vectorize", () => ({ upsertFactVector, deleteFactVectors }));
vi.mock("../../src/memory/repo", () => ({
  upsertSimilarMemoryFact,
  listActiveMemoryFacts,
  getActiveMemoryFactByTarget,
  deleteMemoryFactById,
}));

import {
  executeMemoryFind,
  executeMemoryRemove,
  executeMemorySave,
} from "../../src/memory/execute-api";

describe("memory execute api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("find returns normalized facts", async () => {
    retrieveMemoryContext.mockResolvedValue({
      facts: [{ id: "fact_1", kind: "fact", text: "User likes concise replies", confidence: 0.9 }],
      episodes: [],
    });

    const result = await executeMemoryFind({
      env: {} as never,
      db: {} as never,
      chatId: 777,
      embeddingModel: "model",
      payload: { query: "concise", topK: 3 },
    });

    expect(retrieveMemoryContext).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 777, query: "concise", factTopK: 3 }),
    );
    expect(result).toEqual({
      query: "concise",
      count: 1,
      truncated: false,
      facts: [{ id: "fact_1", kind: "fact", text: "User likes concise replies", confidence: 0.9 }],
    });
  });

  it("find supports empty query by listing top facts", async () => {
    listActiveMemoryFacts.mockResolvedValue([
      { id: "fact_1", kind: "identity", text: "You are dréclaw", confidence: 0.95 },
    ]);

    const result = await executeMemoryFind({
      env: {} as never,
      db: {} as never,
      chatId: 777,
      embeddingModel: "model",
      payload: { query: "", topK: 3 },
    });

    expect(listActiveMemoryFacts).toHaveBeenCalledWith(expect.anything(), 777, 3);
    expect(result).toEqual({
      query: "",
      count: 1,
      truncated: false,
      facts: [{ id: "fact_1", kind: "identity", text: "You are dréclaw", confidence: 0.95 }],
    });
  });

  it("rejects unsupported memory.find args", async () => {
    await expect(
      executeMemoryFind({
        env: {} as never,
        db: {} as never,
        chatId: 777,
        embeddingModel: "model",
        payload: { query: "x", table: "episodes" },
      }),
    ).rejects.toThrow("memory.find unsupported args: table");
  });

  it("save upserts fact and vector", async () => {
    upsertSimilarMemoryFact.mockResolvedValue({
      created: true,
      fact: {
        id: "fact_2",
        kind: "preference",
        text: "User prefers bullet lists",
        confidence: 0.88,
      },
    });
    embedText.mockResolvedValue([0.1, 0.2]);

    const result = await executeMemorySave({
      env: {} as never,
      db: {} as never,
      chatId: 777,
      embeddingModel: "model",
      payload: { text: "User prefers bullet lists", kind: "preference", confidence: 0.88 },
    });

    expect(upsertSimilarMemoryFact).toHaveBeenCalled();
    expect(embedText).toHaveBeenCalledWith(expect.anything(), "model", "User prefers bullet lists");
    expect(upsertFactVector).toHaveBeenCalledWith(expect.anything(), "fact_2", 777, [0.1, 0.2]);
    expect(result).toEqual({
      id: "fact_2",
      created: true,
      kind: "preference",
      text: "User prefers bullet lists",
      confidence: 0.88,
    });
  });

  it("remove deletes by target", async () => {
    getActiveMemoryFactByTarget.mockResolvedValue({ id: "fact_9" });
    deleteMemoryFactById.mockResolvedValue(true);

    const result = await executeMemoryRemove({
      env: {} as never,
      db: {} as never,
      chatId: 777,
      payload: { target: "fact_9" },
    });

    expect(getActiveMemoryFactByTarget).toHaveBeenCalledWith(expect.anything(), 777, "fact_9");
    expect(deleteMemoryFactById).toHaveBeenCalledWith(expect.anything(), 777, "fact_9");
    expect(deleteFactVectors).toHaveBeenCalledWith(expect.anything(), ["fact_9"]);
    expect(result).toEqual({ ok: true, removedId: "fact_9", message: "Memory removed" });
  });
});
