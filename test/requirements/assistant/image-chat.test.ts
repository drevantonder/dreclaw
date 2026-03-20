import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

function promptText(messages: unknown[]): string {
  return JSON.stringify(messages);
}

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => (_modelId: string) => ({ id: "mock-model" }),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");

  class MockToolLoopAgent {
    private readonly tools: Record<string, { execute?: (args: unknown) => Promise<unknown> }>;

    constructor(options?: {
      tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>;
    }) {
      this.tools = options?.tools ?? {};
    }

    async stream(options?: {
      messages?: unknown[];
      onStepFinish?: (step: { toolCalls: unknown[]; text: string }) => void;
    }) {
      const prompt = promptText((options?.messages as unknown[]) ?? []);

      if (
        prompt.includes("Save a note about that image.") &&
        prompt.includes("The image is a red square.")
      ) {
        const toolCall = {
          type: "toolCall",
          id: "tool-image-1",
          name: "codemode",
          arguments: {
            code: [
              "async () => {",
              '  await state.writeFile("/tmp/image-note.txt", "saved-image-note");',
              '  return await state.readFile("/tmp/image-note.txt");',
              "}",
            ].join("\n"),
          },
        };
        await this.tools.codemode?.execute?.(toolCall.arguments);
        options?.onStepFinish?.({ toolCalls: [toolCall], text: "" });
        const text = "Saved a note about the red square.";
        options?.onStepFinish?.({ toolCalls: [], text });
        return {
          textStream: (async function* () {
            yield text;
          })(),
          text: Promise.resolve(text),
          response: Promise.resolve({ messages: [{ role: "assistant", content: text }] }),
        };
      }

      let text = "I do not know which image you mean yet.";
      if (
        prompt.includes("What color is this image?") &&
        prompt.includes("data:image/png;base64")
      ) {
        text = "The image is a red square.";
      } else if (
        prompt.includes("What color was it?") &&
        prompt.includes("The image is a red square.")
      ) {
        text = "The image was red.";
      }

      options?.onStepFinish?.({ toolCalls: [], text });
      return {
        textStream: (async function* () {
          yield text;
        })(),
        text: Promise.resolve(text),
        response: Promise.resolve({ messages: [{ role: "assistant", content: text }] }),
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

async function primeImageConversation() {
  const harness = createAssistantHarness();
  await harness.sendImage({ caption: "What color is this image?" });
  harness.clearCalls();
  return harness;
}

describe("assistant image requirements", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a first-turn image question usefully", async () => {
    const harness = createAssistantHarness();

    await harness.sendImage({ caption: "What color is this image?" });

    expect(harness.finalAssistantText()).toContain("red square");
  });

  it("keeps image continuity across follow-up turns", async () => {
    const harness = await primeImageConversation();

    await harness.send("What color was it?");

    expect(harness.finalAssistantText()).toContain("red");
  });

  it("can use tools during an image-based conversation", async () => {
    const harness = await primeImageConversation();

    await harness.send("Save a note about that image.");

    expect(harness.finalAssistantText()).toContain("Saved a note about the red square.");
  });

  it("/new, /reset, and /factory-reset break image-thread continuity", async () => {
    const withNew = await primeImageConversation();
    await withNew.send("/new");
    withNew.clearCalls();
    await withNew.send("What color was it?");
    expect(withNew.finalAssistantText()).toContain("do not know which image");

    const withReset = await primeImageConversation();
    await withReset.send("/reset");
    withReset.clearCalls();
    await withReset.send("What color was it?");
    expect(withReset.finalAssistantText()).toContain("do not know which image");

    const withFactoryReset = await primeImageConversation();
    await withFactoryReset.send("/factory-reset");
    withFactoryReset.clearCalls();
    await withFactoryReset.send("What color was it?");
    expect(withFactoryReset.finalAssistantText()).toContain("do not know which image");
  });
});
