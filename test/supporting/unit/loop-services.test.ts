import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const stream = vi.fn();
  const generateText = vi.fn();
  const streamTelegramReply = vi.fn();
  class ToolLoopAgentMock {
    constructor(_options: unknown) {}

    stream = stream;
  }
  return {
    ToolLoopAgent: ToolLoopAgentMock,
    stream,
    stepCountIs: vi.fn((value: number) => value),
    generateText,
    streamTelegramReply,
  };
});

vi.mock("ai", () => ({
  ToolLoopAgent: mocks.ToolLoopAgent,
  stepCountIs: mocks.stepCountIs,
  generateText: mocks.generateText,
}));

vi.mock("../../../src/chat-adapters/telegram/api", () => ({
  streamTelegramReply: mocks.streamTelegramReply,
}));

import { createConversationLoopService } from "../../../src/core/runtime/services/conversation";
import { createProactiveWakeService } from "../../../src/core/runtime/services/proactive-wake";
import { normalizeBotThreadState } from "../../../src/core/loop/state";
import type { CreateAgentTools } from "../../../src/core/runtime/tools/toolbox";
import { createEnv } from "../../helpers/fakes";

function emptyStream(): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      yield "";
    },
  };
}

describe("loop services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completes a simple conversation step without tools", async () => {
    const { env } = createEnv();
    mocks.stream.mockImplementation(
      async ({ onStepFinish }: { onStepFinish?: (step: unknown) => void }) => {
        onStepFinish?.({ toolCalls: [], text: "" });
        return {
          textStream: emptyStream(),
          response: Promise.resolve({ messages: [] }),
          text: Promise.resolve("assistant reply"),
        };
      },
    );
    mocks.streamTelegramReply.mockResolvedValue({ text: "assistant reply" });

    const service = createConversationLoopService({
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

    const result = await service.runConversationStep({
      thread: {
        id: "telegram:777",
        startTyping: vi.fn(async () => undefined),
        setState: vi.fn(async () => undefined),
        post: vi.fn(async () => undefined),
      } as never,
      message: { text: "hello" } as never,
      chatId: 777,
      state: normalizeBotThreadState(undefined),
      isFirstStep: true,
    });

    expect(result.shouldContinue).toBe(false);
    expect(result.state.history.map((entry) => entry.role)).toEqual(["user", "assistant"]);
  });

  it("returns a visible proactive message for visible reminders", async () => {
    const { env } = createEnv();
    mocks.stream.mockImplementation(async () => ({
      textStream: emptyStream(),
      response: Promise.resolve({ messages: [] }),
      text: Promise.resolve("Follow up now."),
    }));

    const service = createProactiveWakeService({
      runtimeDeps: env as never,
      runs: {
        throwIfCancelled: async () => undefined,
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

    const result = await service.runProactiveWake({
      threadId: "telegram:777",
      chatId: 777,
      state: normalizeBotThreadState(undefined),
      item: {
        id: "reminder-1",
        title: "Follow up",
        kind: "task",
        delivery: "visible",
        priority: 3,
        notes: "",
        nextWakeAt: "2026-03-17T00:00:00.000Z",
      } as never,
      recentWakeSummaries: [],
    });

    expect(result.messageText).toBe("Follow up now.");
    expect(result.summary).toContain("Follow up now.");
    expect(result.state.history).toEqual([{ role: "assistant", content: "Follow up now." }]);
  });

  it("keeps proactive wakes silent when the model replies NO_MESSAGE", async () => {
    const { env } = createEnv();
    mocks.stream.mockImplementation(async () => ({
      textStream: emptyStream(),
      response: Promise.resolve({ messages: [] }),
      text: Promise.resolve("NO_MESSAGE"),
    }));

    const service = createProactiveWakeService({
      runtimeDeps: env as never,
      runs: {
        throwIfCancelled: async () => undefined,
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

    const result = await service.runProactiveWake({
      threadId: "telegram:777",
      chatId: 777,
      state: normalizeBotThreadState(undefined),
      item: {
        id: "reminder-1",
        title: "Follow up",
        kind: "task",
        delivery: "silent",
        priority: 3,
        notes: "",
        nextWakeAt: "2026-03-17T00:00:00.000Z",
      } as never,
      recentWakeSummaries: [],
    });

    expect(result.messageText).toBe(null);
    expect(result.summary).toContain("silent wake");
    expect(result.state.history).toHaveLength(0);
  });
});
