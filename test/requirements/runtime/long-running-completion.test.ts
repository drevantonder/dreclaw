import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

describe("runtime long-running completion requirements", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("runs a very long workflow-backed request to completion and drains a queued second turn", async () => {
    vi.useFakeTimers();
    const scenarioSecret = "live-test-secret";
    const harness = createAssistantHarness({
      envOverrides: {
        LIVE_TEST_SCENARIOS_ENABLED: "true",
        LIVE_TEST_SCENARIO_SECRET: scenarioSecret,
      },
    });
    const firstRunId = "requirement-long-1";
    const secondRunId = "requirement-long-2";
    const firstPrompt = [
      "LIVE_TEST_SCENARIO",
      "long-run-queue",
      `run=${firstRunId}`,
      `secret=${scenarioSecret}`,
      "duration_ms=65000",
      "step_ms=5000",
    ].join(" ");
    const secondPrompt = [
      "LIVE_TEST_SCENARIO",
      "long-run-queue",
      `run=${secondRunId}`,
      `secret=${scenarioSecret}`,
      "duration_ms=5000",
      "step_ms=5000",
    ].join(" ");

    const first = await harness.dispatch(firstPrompt);
    expect(first.status).toBe(200);

    await vi.advanceTimersByTimeAsync(1_500);
    const status = await harness.dispatch("/status");
    expect(status.status).toBe(200);

    const second = await harness.dispatch(secondPrompt);
    expect(second.status).toBe(200);

    expect(harness.visibleTexts().join("\n")).toContain("busy: yes");
    const typingBeforeCompletion = typingCalls(harness.calls).length;

    for (let index = 0; index < 15; index += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await harness.waitForIdle();

    const output = harness.visibleTexts().join("\n");
    const replies = replyCalls(harness.calls);

    expect(output).not.toContain("Currently busy. Not executed. Use /status or /stop.");
    expect(output).toContain(`LIVE_TEST long-run-queue complete run=${firstRunId}`);
    expect(output).toContain(`LIVE_TEST long-run-queue complete run=${secondRunId}`);
    expect(output.indexOf(`LIVE_TEST long-run-queue complete run=${firstRunId}`)).toBeLessThan(
      output.indexOf(`LIVE_TEST long-run-queue complete run=${secondRunId}`),
    );
    expect(typingCalls(harness.calls).length).toBeGreaterThan(typingBeforeCompletion + 4);
    expect(replies.map((call) => call.text).join("\n")).toContain("busy: yes");
  });
});
