import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  zenModels: [] as any[],
  streamTelegramReply: vi.fn(async ({ textStream }: { textStream: AsyncIterable<string> }) => {
    let text = "";
    for await (const chunk of textStream) text += chunk;
    return { text };
  }),
}));

vi.mock("../../../src/core/runtime/llm/zen", () => ({
  createZenModel: () => {
    const model = mocks.zenModels.shift();
    if (!model) throw new Error("Missing mocked zen model");
    return model;
  },
}));

vi.mock("../../../src/chat-adapters/telegram/api", () => ({
  streamTelegramReply: mocks.streamTelegramReply,
}));

import { createConversationLoopService } from "../../../src/core/runtime/services/conversation";
import { normalizeBotThreadState } from "../../../src/core/loop/state";
import type { CreateAgentTools } from "../../../src/core/runtime/tools/toolbox";
import { createEnv } from "../../helpers/fakes";
import { createStreamingTextModel } from "../../helpers/mock-models";

function createService(reasoningEffort = "high") {
  const { env } = createEnv({ REASONING_EFFORT: reasoningEffort });
  return createConversationLoopService({
    runtimeDeps: env as never,
    runs: {
      startRun: (state: unknown) => state,
      recoverState: async (_threadId: string, state: unknown) => state,
      persistRunState: async () => undefined,
      throwIfCancelled: async () => undefined,
      finishRun: (state: unknown) => state,
      createHeartbeat: () => ({ start() {}, stop() {} }),
    } as never,
    workspaceGateway: {
      listSkills: vi.fn(async () => []),
      getLoadedSkills: vi.fn(async () => []),
    } as never,
    memoryGateway: {
      renderContext: vi.fn(async () => ""),
    } as never,
    createTools: vi.fn(() => ({})) as unknown as CreateAgentTools,
  });
}

describe("assistant thinking wiring", () => {
  beforeEach(() => {
    mocks.zenModels.length = 0;
    mocks.streamTelegramReply.mockClear();
  });

  it("requests configured reasoning effort when thinking is on", async () => {
    const model = createStreamingTextModel({
      textSegments: ["assistant reply"],
      provider: "mock-opencode",
      modelId: "kimi-k2.5",
    });
    mocks.zenModels.push(model);
    const service = createService("high");

    await service.runConversationStep({
      thread: {
        id: "telegram:777",
        startTyping: vi.fn(async () => undefined),
        setState: vi.fn(async () => undefined),
        post: vi.fn(async () => undefined),
      } as never,
      message: { text: "hello there" } as never,
      chatId: 777,
      state: { ...normalizeBotThreadState(undefined), modelAlias: "kimi", thinking: true },
      isFirstStep: true,
    });

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.providerOptions).toMatchObject({
      opencode: { reasoningEffort: "high" },
    });
  });

  it("disables requested reasoning effort when thinking is off", async () => {
    const model = createStreamingTextModel({
      textSegments: ["assistant reply"],
      provider: "mock-opencode",
      modelId: "kimi-k2.5",
    });
    mocks.zenModels.push(model);
    const service = createService("high");

    await service.runConversationStep({
      thread: {
        id: "telegram:777",
        startTyping: vi.fn(async () => undefined),
        setState: vi.fn(async () => undefined),
        post: vi.fn(async () => undefined),
      } as never,
      message: { text: "hello there" } as never,
      chatId: 777,
      state: { ...normalizeBotThreadState(undefined), modelAlias: "kimi", thinking: false },
      isFirstStep: true,
    });

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.providerOptions).toMatchObject({
      opencode: { reasoningEffort: "none" },
    });
  });
});
