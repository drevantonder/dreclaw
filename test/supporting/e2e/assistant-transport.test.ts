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

describe("assistant transport", () => {
  beforeEach(() => {
    assistantQueue.length = 0;
  });

  it("uses Telegram draft updates when drafts are supported", async () => {
    const harness = createAssistantHarness();
    assistantQueue.push({
      textSegments: ["Blue", " sky", "."],
      delayMs: 380,
    });

    await harness.send("Reply with blue sky.");

    expect(harness.methods()).toContain("sendMessageDraft");
    expect(harness.methods()).not.toContain("editMessageText");
    expect(harness.finalAssistantText()).toContain("Blue sky.");
  });

  it("falls back to send and edit when drafts are unsupported", async () => {
    const harness = createAssistantHarness({ draftUnsupported: true });
    assistantQueue.push({
      textSegments: ["Blue", " sky", "."],
      delayMs: 380,
    });

    await harness.send("Reply with blue sky.");

    expect(harness.methods()).toContain("sendMessageDraft");
    expect(harness.methods()).toContain("sendMessage");
    expect(harness.methods()).toContain("editMessageText");
    expect(harness.finalAssistantText()).toContain("Blue sky.");
  });
});
