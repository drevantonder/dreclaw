import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { seenPrompts } = vi.hoisted(() => ({
  seenPrompts: [] as string[],
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");

  class MockToolLoopAgent {
    constructor(_options?: unknown) {}

    async stream(options?: {
      messages?: unknown[];
      onStepFinish?: (step: { toolCalls: unknown[]; text: string }) => void;
    }) {
      const prompt = JSON.stringify(options?.messages ?? []);
      seenPrompts.push(prompt);

      let text = "Okay.";
      if (prompt.includes("What is my project codename?")) {
        text = prompt.includes("amber-fox")
          ? "Your project codename is amber-fox."
          : "I do not know your project codename yet.";
      } else if (prompt.includes("For this chat, my project codename is amber-fox.")) {
        text = "Saved.";
      }

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

async function primeConversation() {
  const harness = createAssistantHarness();
  await harness.send("For this chat, my project codename is amber-fox.");
  harness.clearCalls();
  return harness;
}

describe("assistant multi-turn requirements", () => {
  beforeEach(() => {
    seenPrompts.length = 0;
  });

  it("answers a follow-up using prior chat context", async () => {
    const harness = await primeConversation();

    await harness.send("What is my project codename?");

    expect(harness.finalAssistantText()).toContain("amber-fox");
    expect(harness.visibleTexts().join("\n")).not.toContain("Tool:");
  });

  it("/new starts a fresh session for follow-up questions", async () => {
    const harness = await primeConversation();

    await harness.send("/new");
    harness.clearCalls();

    await harness.send("What is my project codename?");

    expect(harness.finalAssistantText()).toContain("do not know your project codename yet");
    expect(harness.visibleTexts().join("\n")).not.toContain("Tool:");
  });

  it("/reset breaks prior conversation continuity for follow-up questions", async () => {
    const harness = await primeConversation();

    await harness.send("/reset");
    harness.clearCalls();

    await harness.send("What is my project codename?");

    expect(harness.finalAssistantText()).toContain("do not know your project codename yet");
    expect(harness.visibleTexts().join("\n")).not.toContain("Tool:");
  });

  it("/factory-reset breaks prior conversation continuity for follow-up questions", async () => {
    const harness = await primeConversation();

    await harness.send("/factory-reset");
    harness.clearCalls();

    await harness.send("What is my project codename?");

    expect(harness.finalAssistantText()).toContain("do not know your project codename yet");
    expect(harness.visibleTexts().join("\n")).not.toContain("Tool:");
  });
});
