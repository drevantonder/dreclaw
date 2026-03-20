import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { wakeReplies } = vi.hoisted(() => ({
  wakeReplies: [] as string[],
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");

  class MockToolLoopAgent {
    constructor(_options?: unknown) {}

    async stream(options?: { messages?: unknown[] }) {
      const prompt = JSON.stringify(options?.messages ?? []);
      const text =
        wakeReplies.shift() ??
        (prompt.includes('"delivery: silent"') ? "NO_MESSAGE" : "Follow up now.");
      return {
        textStream: (async function* () {
          yield text;
        })(),
        text: Promise.resolve(text),
        response: Promise.resolve({ messages: [] }),
      };
    }
  }

  return {
    ...actual,
    ToolLoopAgent: MockToolLoopAgent,
    stepCountIs: (count: number) => ({ count }),
    generateText: vi.fn(async () => ({ text: "Recovered." })),
  };
});

import { handleScheduled } from "../../../src/app/cloudflare";
import { buildRemindersPluginDeps } from "../../../src/app/deps";
import { createRemindersPlugin } from "../../../src/plugins/reminders";
import { waitForWorkflowTasks } from "../../helpers/fakes";
import { createAssistantHarness } from "../../helpers/assistant-harness";

function reminderTexts(harness: ReturnType<typeof createAssistantHarness>) {
  return harness.visibleTexts().filter((text) => text && !text.startsWith("Reasoning:\n"));
}

describe("proactive reminder requirements", () => {
  beforeEach(() => {
    wakeReplies.length = 0;
  });

  it("delivers a visible proactive message by default when a reminder becomes due", async () => {
    const harness = createAssistantHarness();
    const reminders = createRemindersPlugin(buildRemindersPluginDeps(harness.env));

    await reminders.updateReminder(
      {
        action: "create",
        item: {
          title: "Default visible reminder",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );

    await handleScheduled(harness.env);
    await waitForWorkflowTasks();

    expect(reminderTexts(harness).join("\n")).toContain("Follow up now.");
    expect([...harness.db.reminderRuns.values()].at(-1)?.summary).toContain("Follow up now.");
  });

  it("keeps explicit silent reminders from posting a user-visible message", async () => {
    const harness = createAssistantHarness();
    const reminders = createRemindersPlugin(buildRemindersPluginDeps(harness.env));

    await reminders.updateReminder(
      {
        action: "create",
        item: {
          title: "Silent reminder",
          delivery: "silent",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );

    await handleScheduled(harness.env);
    await waitForWorkflowTasks();

    expect(reminderTexts(harness)).toEqual([]);
    expect([...harness.db.reminderRuns.values()].at(-1)?.summary).toContain("silent wake");
  });

  it("does not send proactive messages for completed reminders", async () => {
    const harness = createAssistantHarness();
    const reminders = createRemindersPlugin(buildRemindersPluginDeps(harness.env));

    const created = await reminders.updateReminder(
      {
        action: "create",
        item: {
          title: "Completed reminder",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );
    const reminderId = (created as { item: { id: string } }).item.id;
    await reminders.updateReminder(
      { action: "complete", itemId: reminderId },
      { sourceChatId: 777 },
    );

    await handleScheduled(harness.env);
    await waitForWorkflowTasks();

    expect(reminderTexts(harness)).toEqual([]);
    expect(harness.db.reminderRuns.size).toBe(0);
  });

  it("does not duplicate delivery when scheduled processing runs again", async () => {
    const harness = createAssistantHarness();
    const reminders = createRemindersPlugin(buildRemindersPluginDeps(harness.env));

    await reminders.updateReminder(
      {
        action: "create",
        item: {
          title: "No duplicate reminder",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );

    await handleScheduled(harness.env);
    await waitForWorkflowTasks();
    const firstCount = reminderTexts(harness).length;

    await handleScheduled(harness.env);
    await waitForWorkflowTasks();

    expect(firstCount).toBe(1);
    expect(reminderTexts(harness)).toHaveLength(1);
  });
});
