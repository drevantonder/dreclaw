import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type MockAssistantStep = {
  stopReason: "endTurn" | "toolUse";
  content: Array<Record<string, unknown>>;
  waitBeforeToolCalls?: Promise<void>;
  reasoningText?: string | Promise<string | undefined> | undefined;
};

const { modelQueue } = vi.hoisted(() => ({
  modelQueue: [] as MockAssistantStep[],
}));

function textValue(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
      ? String(value)
      : "";
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitForText(read: () => string, needle: string, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (read().includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for visible text: ${needle}`);
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
      let finalReasoningText: string | Promise<string | undefined> | undefined;
      while (true) {
        const next = modelQueue.shift();
        if (!next) throw new Error("Missing mocked model response");
        if (next.waitBeforeToolCalls) await next.waitBeforeToolCalls;
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
          finalReasoningText = next.reasoningText;
          break;
        }
      }
      return {
        textStream: (async function* () {
          if (finalText) yield finalText;
        })(),
        text: Promise.resolve(finalText),
        response: Promise.resolve({ messages: responseMessages }),
        reasoningText: Promise.resolve(finalReasoningText),
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

function queueToolRun(waitBeforeToolCalls: Promise<void>) {
  modelQueue.push(
    {
      stopReason: "toolUse",
      waitBeforeToolCalls,
      content: [
        {
          type: "toolCall",
          id: "tool-inflight-1",
          name: "codemode",
          arguments: {
            code: [
              "async () => {",
              '  await state.writeFile("/tmp/inflight-verbose.txt", "trace me");',
              '  return await state.readFile("/tmp/inflight-verbose.txt");',
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

function queueReasoningRun(reasoningText: Promise<string | undefined>) {
  modelQueue.push({
    stopReason: "endTurn",
    content: [{ type: "text", text: "Answer ready." }],
    reasoningText,
  });
}

describe("assistant in-flight control requirements", () => {
  beforeEach(() => {
    modelQueue.length = 0;
  });

  it("/verbose on changes same-run trace visibility before the run finishes", async () => {
    const harness = createAssistantHarness();
    const releaseTool = createDeferred();
    queueToolRun(releaseTool.promise);

    const first = await harness.dispatch("Do the tool-backed task.");
    expect(first.status).toBe(200);

    const toggle = await harness.dispatch("/verbose on");
    expect(toggle.status).toBe(200);
    await waitForText(() => harness.visibleTexts().join("\n"), "verbose enabled.");

    releaseTool.resolve();
    await harness.waitForIdle();

    const output = harness.visibleTexts().join("\n");
    expect(output).toContain("verbose enabled.");
    expect(output).toContain("Tool: codemode");
    expect(output).toContain('state.writeFile("/tmp/inflight-verbose.txt", "trace me")');
    expect(output.indexOf("verbose enabled.")).toBeLessThan(output.indexOf("Tool: codemode"));
    expect(harness.finalAssistantText()).toContain("Finished the tool-backed task.");
  });

  it("/verbose off hides later same-run trace output before the run finishes", async () => {
    const harness = createAssistantHarness();
    await harness.send("/verbose on");
    harness.clearCalls();
    const releaseTool = createDeferred();
    queueToolRun(releaseTool.promise);

    const first = await harness.dispatch("Do the tool-backed task.");
    expect(first.status).toBe(200);

    const toggle = await harness.dispatch("/verbose off");
    expect(toggle.status).toBe(200);
    await waitForText(() => harness.visibleTexts().join("\n"), "verbose disabled.");

    releaseTool.resolve();
    await harness.waitForIdle();

    const output = harness.visibleTexts().join("\n");
    expect(output).toContain("verbose disabled.");
    expect(output).not.toContain("Tool: codemode");
    expect(harness.finalAssistantText()).toContain("Finished the tool-backed task.");
  });

  it("/reasoning on changes same-run visible reasoning before the run finishes", async () => {
    const harness = createAssistantHarness();
    const releaseReasoning = createDeferred();
    queueReasoningRun(releaseReasoning.promise.then(() => "Think through"));

    const first = await harness.dispatch("Reply with answer ready.");
    expect(first.status).toBe(200);

    const toggle = await harness.dispatch("/reasoning on");
    expect(toggle.status).toBe(200);
    await waitForText(() => harness.visibleTexts().join("\n"), "reasoning enabled.");

    releaseReasoning.resolve();
    await harness.waitForIdle();

    const output = harness.visibleTexts().join("\n");
    expect(output).toContain("reasoning enabled.");
    expect(output).toContain("Reasoning:\nThink through");
    expect(output.indexOf("reasoning enabled.")).toBeLessThan(
      output.indexOf("Reasoning:\nThink through"),
    );
    expect(harness.finalAssistantText()).toContain("Answer ready.");
  });

  it("/reasoning off hides later same-run visible reasoning before the run finishes", async () => {
    const harness = createAssistantHarness();
    await harness.send("/reasoning on");
    harness.clearCalls();
    const releaseReasoning = createDeferred();
    queueReasoningRun(releaseReasoning.promise.then(() => "Think through"));

    const first = await harness.dispatch("Reply with answer ready.");
    expect(first.status).toBe(200);

    const toggle = await harness.dispatch("/reasoning off");
    expect(toggle.status).toBe(200);
    await waitForText(() => harness.visibleTexts().join("\n"), "reasoning disabled.");

    releaseReasoning.resolve();
    await harness.waitForIdle();

    const output = harness.visibleTexts().join("\n");
    expect(output).toContain("reasoning disabled.");
    expect(output).not.toContain("Reasoning:\nThink through");
    expect(harness.finalAssistantText()).toContain("Answer ready.");
  });
});
