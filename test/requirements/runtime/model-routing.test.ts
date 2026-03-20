import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  workersCalls: [] as string[],
  zenCalls: [] as Array<{ providerName?: string; model: string; baseUrl: string }>,
}));

vi.mock("../../../src/core/runtime/llm/workers", () => ({
  createWorkersModel: (_binding: Ai, model: string) => {
    mocks.workersCalls.push(model);
    return { id: `workers:${model}` };
  },
}));

vi.mock("../../../src/core/runtime/llm/zen", () => ({
  createZenModel: (runtime: { providerName?: string; model: string; baseUrl: string }) => {
    mocks.zenCalls.push(runtime);
    return { id: `zen:${runtime.model}` };
  },
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");

  class MockToolLoopAgent {
    constructor(_options?: unknown) {}

    async stream(options?: {
      onStepFinish?: (step: { toolCalls: unknown[]; text: string }) => void;
    }) {
      const text = "Model routing check complete.";
      options?.onStepFinish?.({ toolCalls: [], text });
      return {
        textStream: (async function* () {
          yield text;
        })(),
        text: Promise.resolve(text),
        response: Promise.resolve({ messages: [] }),
        reasoningText: Promise.resolve(undefined),
      };
    }
  }

  return {
    ...actual,
    ToolLoopAgent: MockToolLoopAgent,
    stepCountIs: (count: number) => ({ count }),
  };
});

import { createAssistantHarness } from "../../helpers/assistant-harness";

describe("runtime model routing requirements", () => {
  beforeEach(() => {
    mocks.workersCalls.length = 0;
    mocks.zenCalls.length = 0;
  });

  it("uses the default workers route before model changes", async () => {
    const harness = createAssistantHarness();

    await harness.send("Say hi.");

    expect(harness.finalAssistantText()).toContain("Model routing check complete.");
    expect(mocks.workersCalls).toContain("@cf/zai-org/glm-4.7-flash");
    expect(mocks.zenCalls).toHaveLength(0);
  });

  it("routes the next assistant run through the selected alias", async () => {
    const harness = createAssistantHarness();

    await harness.send("/model kimi");
    await harness.send("/status");
    harness.clearCalls();
    await harness.send("Say hi.");

    expect(harness.finalAssistantText()).toContain("Model routing check complete.");
    expect(mocks.zenCalls.at(-1)?.model).toBe("kimi-k2.5");
    expect(mocks.zenCalls.at(-1)?.providerName).toBe("opencode");
  });

  it("/new and /reset preserve the selected runtime route", async () => {
    const withNew = createAssistantHarness();
    await withNew.send("/model kimi");
    await withNew.send("/new");
    await withNew.send("Say hi.");
    expect(mocks.zenCalls.at(-1)?.model).toBe("kimi-k2.5");

    mocks.workersCalls.length = 0;
    mocks.zenCalls.length = 0;

    const withReset = createAssistantHarness();
    await withReset.send("/model kimi");
    await withReset.send("/reset");
    await withReset.send("Say hi.");
    expect(mocks.zenCalls.at(-1)?.model).toBe("kimi-k2.5");
  });

  it("/factory-reset clears the alias and restores the default route", async () => {
    const harness = createAssistantHarness();

    await harness.send("/model kimi");
    await harness.send("/factory-reset");
    harness.clearCalls();
    await harness.send("Say hi.");

    expect(harness.finalAssistantText()).toContain("Model routing check complete.");
    expect(mocks.workersCalls.at(-1)).toBe("@cf/zai-org/glm-4.7-flash");
  });
});
