import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { assistantQueue } = vi.hoisted(() => ({
  assistantQueue: [] as Array<{ textSegments: string[]; delayMs?: number }>,
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

describe("assistant overlap requirements", () => {
  beforeEach(() => {
    assistantQueue.length = 0;
  });

  it("queues a second normal message sent before the first reply completes", async () => {
    const harness = createAssistantHarness();
    assistantQueue.push(
      {
        textSegments: ["First", " answer."],
        delayMs: 300,
      },
      {
        textSegments: ["Second", " answer."],
      },
    );

    const first = await harness.dispatch("Reply with the first answer.");
    const second = await harness.dispatch("Reply with the second answer.");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    await harness.waitForIdle();

    const output = harness.visibleTexts().join("\n");

    expect(output).not.toContain("Currently busy. Not executed. Use /status or /stop.");
    expect(output).toContain("First answer.");
    expect(output).toContain("Second answer.");
    expect(output.indexOf("First answer.")).toBeLessThan(output.lastIndexOf("Second answer."));
  });
});
