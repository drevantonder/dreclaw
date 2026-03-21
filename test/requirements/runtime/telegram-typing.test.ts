import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { assistantQueue } = vi.hoisted(() => ({
  assistantQueue: [] as Array<{ textSegments: string[]; initialDelayMs?: number }>,
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
          if ((next.initialDelayMs ?? 0) > 0) {
            await new Promise((resolve) => setTimeout(resolve, next.initialDelayMs));
          }
          for (const segment of next.textSegments) yield segment;
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

import { handleScheduled } from "../../../src/app/cloudflare";
import { buildRemindersPluginDeps } from "../../../src/app/deps";
import { createRemindersPlugin } from "../../../src/plugins/reminders";
import { waitForWorkflowTasks } from "../../helpers/fakes";
import {
  createAssistantHarness,
  type TelegramTransportCall,
} from "../../helpers/assistant-harness";

const REPLY_METHODS = new Set(["sendMessageDraft", "sendMessage", "editMessageText"]);

function typingCalls(calls: TelegramTransportCall[]) {
  return calls.filter((call) => call.method === "sendChatAction");
}

function replyCalls(calls: TelegramTransportCall[]) {
  return calls.filter((call) => REPLY_METHODS.has(call.method) && call.text.trim().length > 0);
}

function maxGapMs(calls: TelegramTransportCall[]) {
  let maxGap = 0;
  for (let index = 1; index < calls.length; index += 1) {
    maxGap = Math.max(maxGap, calls[index]!.atMs - calls[index - 1]!.atMs);
  }
  return maxGap;
}

describe("telegram typing requirements", () => {
  beforeEach(() => {
    assistantQueue.length = 0;
    vi.useRealTimers();
  });

  it("starts typing quickly and keeps typing fresh until a long assistant reply is sent", async () => {
    vi.useFakeTimers();
    const harness = createAssistantHarness();
    assistantQueue.push({
      textSegments: ["Delayed reply."],
      initialDelayMs: 6_500,
    });

    const response = await harness.dispatch("Reply later.");
    expect(response.status).toBe(200);

    await vi.advanceTimersByTimeAsync(6_500);
    await harness.waitForIdle();

    const typing = typingCalls(harness.calls);
    const replies = replyCalls(harness.calls);
    expect(typing.length).toBeGreaterThanOrEqual(3);
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const finalReply = replies.at(-1)!;
    expect(typing[0]!.atMs).toBeLessThanOrEqual(finalReply.atMs);
    expect(maxGapMs(typing)).toBeLessThanOrEqual(5_000);
    expect(typing.at(-1)!.atMs).toBeLessThanOrEqual(finalReply.atMs);

    const typingCountAfterReply = typing.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(typingCalls(harness.calls)).toHaveLength(typingCountAfterReply);
  });

  it("shows typing for slash commands before replying and stops afterward", async () => {
    vi.useFakeTimers();
    const harness = createAssistantHarness();

    const response = await harness.send("/help");
    expect(response.status).toBe(200);

    const typing = typingCalls(harness.calls);
    const replies = replyCalls(harness.calls);
    expect(typing).toHaveLength(1);
    expect(replies.length).toBeGreaterThanOrEqual(1);
    expect(typing[0]!.atMs).toBeLessThanOrEqual(replies[0]!.atMs);

    const typingCountAfterReply = typing.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(typingCalls(harness.calls)).toHaveLength(typingCountAfterReply);
  });

  it("shows typing before a visible reminder wake reply and stops afterward", async () => {
    vi.useFakeTimers();
    const harness = createAssistantHarness();
    const reminders = createRemindersPlugin(buildRemindersPluginDeps(harness.env));
    assistantQueue.push({ textSegments: ["Follow up now."] });

    await reminders.updateReminder(
      {
        action: "create",
        item: {
          title: "Typing reminder",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );

    await handleScheduled(harness.env);
    await waitForWorkflowTasks();

    const typing = typingCalls(harness.calls);
    const replies = replyCalls(harness.calls);
    expect(typing.length).toBeGreaterThanOrEqual(1);
    expect(replies).toHaveLength(1);
    expect(typing[0]!.atMs).toBeLessThanOrEqual(replies[0]!.atMs);

    const typingCountAfterReply = typing.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(typingCalls(harness.calls)).toHaveLength(typingCountAfterReply);
  });
});
