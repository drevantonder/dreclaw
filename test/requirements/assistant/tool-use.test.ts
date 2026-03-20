import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type MockContext = {
  tools: Array<{
    name: string;
    execute: (toolCallId: string, params: unknown) => Promise<unknown>;
  }>;
};

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

vi.mock("../../../src/plugins/google/execute", () => ({
  executeGoogleRequest: vi.fn(async (_deps, payload: { service?: string; method?: string }) => {
    if (payload.service !== "gmail") throw new Error("GOOGLE_SERVICE_NOT_ALLOWED");
    return { ok: true, status: 200, result: { method: payload.method ?? null } };
  }),
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
        const context: MockContext = {
          tools: Object.entries(this.tools).map(([name, entry]) => ({
            name,
            execute: async (_toolCallId: string, params: unknown) => entry.execute?.(params),
          })),
        };
        const next = modelQueue.shift();
        if (!next) throw new Error("Missing mocked model response");

        const textBlocks = next.content.filter((block) => block.type === "text");
        const toolCalls = next.content.filter((block) => block.type === "toolCall");
        for (const toolCall of toolCalls) {
          const tool = context.tools.find((entry) => entry.name === toolCall.name);
          await tool?.execute(textValue(toolCall.id), toolCall.arguments ?? {});
        }

        const text = textBlocks
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

describe("assistant tool-use requirements", () => {
  beforeEach(() => {
    modelQueue.length = 0;
  });

  it("can use codemode for workspace file tasks during chat", async () => {
    const harness = createAssistantHarness();
    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "tool-state-1",
            name: "codemode",
            arguments: {
              code: [
                "async () => {",
                '  await state.writeFile("/tmp/tool-note.txt", "workspace ready");',
                '  return await state.readFile("/tmp/tool-note.txt");',
                "}",
              ].join("\n"),
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Saved and checked the workspace note." }],
      },
    );

    await harness.send("Create a small workspace note and confirm it worked.");

    expect(harness.finalAssistantText()).toContain("Saved and checked the workspace note.");
    expect(harness.visibleTexts().join("\n")).not.toContain("Tool:");
  });

  it("can use web.fetch during chat and return a useful answer", async () => {
    const harness = createAssistantHarness({
      onFetch: async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url === "https://example.com/tool-requirement") {
          return new Response("fetched tool requirement", { status: 200 });
        }
      },
    });
    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "tool-web-1",
            name: "codemode",
            arguments: {
              code: [
                "async () => {",
                '  const response = await web.fetch({ url: "https://example.com/tool-requirement" });',
                "  return response.body;",
                "}",
              ].join("\n"),
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Fetched the page successfully." }],
      },
    );

    await harness.send("Fetch the web requirement page and confirm success.");

    expect(harness.finalAssistantText()).toContain("Fetched the page successfully.");
    expect(harness.visibleTexts().join("\n")).not.toContain("Tool:");
  });

  it("can create and query reminders during chat", async () => {
    const harness = createAssistantHarness();
    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "tool-reminders-1",
            name: "codemode",
            arguments: {
              code: [
                "async () => {",
                '  await reminders.update({ action: "create", item: { title: "Tool reminder", notes: "Follow up later" } });',
                '  const items = await reminders.query({ filter: { status: "open" } });',
                "  return items.items.length;",
                "}",
              ].join("\n"),
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Created the reminder and confirmed it is open." }],
      },
    );

    await harness.send("Create a reminder for me and confirm it is there.");

    expect(harness.finalAssistantText()).toContain(
      "Created the reminder and confirmed it is open.",
    );
  });

  it("can use google.execute during chat", async () => {
    const harness = createAssistantHarness();
    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "tool-google-1",
            name: "codemode",
            arguments: {
              code: [
                "async () => {",
                '  const result = await google.execute({ service: "gmail", version: "v1", method: "users.messages.list" });',
                "  return result.method;",
                "}",
              ].join("\n"),
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Checked the Google action successfully." }],
      },
    );

    await harness.send("Run a Google check and confirm it worked.");

    expect(harness.finalAssistantText()).toContain("Checked the Google action successfully.");
  });

  it("can use skills during chat", async () => {
    const harness = createAssistantHarness();
    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "tool-skills-1",
            name: "codemode",
            arguments: {
              code: [
                "async () => {",
                '  const loaded = await skills.load({ name: "google" });',
                "  return loaded.name;",
                "}",
              ].join("\n"),
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Loaded the google skill during the chat run." }],
      },
    );

    await harness.send("Use the built-in Google skill and confirm it loaded.");

    expect(harness.finalAssistantText()).toContain("Loaded the google skill during the chat run.");
  });
});
