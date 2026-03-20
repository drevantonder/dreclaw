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
          id: "tool-image-supporting-1",
          name: "codemode",
          arguments: {
            code: [
              "async () => {",
              '  await state.writeFile("/tmp/image-supporting-note.txt", "saved-image-note");',
              '  return await state.readFile("/tmp/image-supporting-note.txt");',
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

describe("assistant image chat supporting coverage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps image context available on a plain follow-up turn", async () => {
    const harness = await primeImageConversation();

    await harness.send("What color was it?");

    expect(harness.finalAssistantText()).toContain("red");
  });

  it("clears image-thread continuity on reset-style commands", async () => {
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
  });

  it("keeps image context available during a tool-backed follow-up", async () => {
    const harness = await primeImageConversation();

    await harness.send("Save a note about that image.");

    expect(harness.finalAssistantText()).toContain("Saved a note about the red square.");
  });
});
