import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type MockAssistant = {
  stopReason: "endTurn" | "toolUse";
  content: Array<Record<string, unknown>>;
};

const { modelQueue } = vi.hoisted(() => ({ modelQueue: [] as MockAssistant[] }));

function textValue(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? String(value)
      : "";
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
      onStepFinish?: (step: { toolCalls: unknown[]; text: string }) => void;
    }) {
      const responseMessages: Array<Record<string, unknown>> = [];
      let finalText = "";
      while (true) {
        const next = modelQueue.shift();
        if (!next) throw new Error("Missing mocked model response");
        const toolCalls = next.content.filter((block) => block.type === "toolCall");
        for (const toolCall of toolCalls) {
          await this.tools[textValue(toolCall.name)]?.execute?.(toolCall.arguments ?? {});
        }
        const text = next.content
          .filter((block) => block.type === "text")
          .map((block) => textValue(block.text))
          .join("\n")
          .trim();
        options?.onStepFinish?.({ toolCalls, text });
        responseMessages.push({ role: "assistant", content: text || "[tool step]" });
        if (next.stopReason === "endTurn") {
          finalText = text;
          break;
        }
      }
      return {
        textStream: (async function* () {
          if (finalText) yield finalText;
        })(),
        text: Promise.resolve(finalText),
        response: Promise.resolve({ messages: responseMessages }),
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

function queueToolRun() {
  modelQueue.push(
    {
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "tool-verbose-1",
          name: "codemode",
          arguments: {
            code: [
              "async () => {",
              '  await state.writeFile("/tmp/verbose.txt", "trace me");',
              '  return await state.readFile("/tmp/verbose.txt");',
              "}",
            ].join("\n"),
          },
        },
      ],
    },
    {
      stopReason: "endTurn",
      content: [{ type: "text", text: "Finished the tool-backed task." }],
    },
  );
}

describe("assistant verbose requirements", () => {
  beforeEach(() => {
    modelQueue.length = 0;
  });

  it("keeps tool traces hidden when verbose is off", async () => {
    const harness = createAssistantHarness();
    queueToolRun();

    await harness.send("Do the tool-backed task.");

    expect(harness.finalAssistantText()).toContain("Finished the tool-backed task.");
    expect(harness.visibleTexts().join("\n")).not.toContain("Tool:");
  });

  it("shows meaningful extra run visibility when verbose is on", async () => {
    const harness = createAssistantHarness();

    await harness.send("/verbose on");
    harness.clearCalls();
    queueToolRun();

    await harness.send("Do the tool-backed task.");

    const output = harness.visibleTexts().join("\n");
    expect(harness.finalAssistantText()).toContain("Finished the tool-backed task.");
    expect(output).toContain("Tool: codemode");
    expect(output).toContain('state.writeFile("/tmp/verbose.txt", "trace me")');
  });
});
