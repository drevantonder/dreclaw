import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { assistantQueue } = vi.hoisted(() => ({
  assistantQueue: [] as Array<{ textSegments: string[]; reasoningText?: string; delayMs?: number }>,
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");

  class MockToolLoopAgent {
    constructor(_options?: unknown) {}

    async stream(options?: {
      onStepFinish?: (step: { toolCalls: unknown[]; text: string }) => void;
    }) {
      const next = assistantQueue.shift();
      if (!next) throw new Error("Missing mocked assistant response");
      const text = next.textSegments.join("");
      options?.onStepFinish?.({ toolCalls: [], text });
      return {
        textStream: (async function* () {
          for (let index = 0; index < next.textSegments.length; index += 1) {
            if (index > 0 && (next.delayMs ?? 0) > 0) {
              await new Promise((resolve) => setTimeout(resolve, next.delayMs));
            }
            yield next.textSegments[index]!;
          }
        })(),
        text: Promise.resolve(text),
        response: Promise.resolve({ messages: [] }),
        reasoningText: Promise.resolve(next.reasoningText),
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

describe("assistant requirements", () => {
  beforeEach(() => {
    assistantQueue.length = 0;
  });

  it("delivers a useful final reply with visible incremental output before completion", async () => {
    const harness = createAssistantHarness();
    assistantQueue.push({
      textSegments: ["Blue", " sky", "."],
      delayMs: 380,
    });

    await harness.send("Reply with blue sky.");

    expect(harness.finalAssistantText()).toContain("Blue sky.");
    expect(harness.hadIncrementalAssistantOutput()).toBe(true);
    expect(harness.reasoningTexts()).toEqual([]);
    expect(harness.visibleTexts().join("\n")).not.toContain("Tool:");
  });

  it("suppresses visible reasoning when reasoning is off", async () => {
    const harness = createAssistantHarness();
    assistantQueue.push({
      textSegments: ["Answer", " ready."],
      reasoningText: "Internal chain",
    });

    await harness.send("Reply with answer ready.");

    expect(harness.finalAssistantText()).toContain("Answer ready.");
    expect(harness.reasoningTexts()).toEqual([]);
  });

  it("posts visible reasoning when reasoning is on", async () => {
    const harness = createAssistantHarness();
    await harness.send("/reasoning on");
    harness.clearCalls();
    assistantQueue.push({
      textSegments: ["Answer", " ready."],
      reasoningText: "Think through",
    });

    await harness.send("Reply with answer ready.");

    expect(harness.finalAssistantText()).toContain("Answer ready.");
    expect(harness.reasoningTexts()).toHaveLength(1);
    expect(harness.reasoningTexts()[0]).toContain("Reasoning:\nThink through");
  });
});
