import { describe, expect, it, vi } from "vite-plus/test";
import { normalizeBotThreadState } from "../../src/core/loop/state";
import {
  getPersistedRunStatus,
  getPersistedWorkflowInstanceId,
  getThreadStateSnapshot,
  setPersistedRunStatus,
  setPersistedThreadControls,
  setPersistedWorkflowInstanceId,
} from "../../src/db";
import { createRunCoordinator } from "../../src/core/loop/run";
import type { ConversationWorkflowPayload, Env } from "../../src/types";
import { createEnv } from "../helpers/fakes";

describe("run coordinator", () => {
  it("reports busy state with the existing active/stale thresholds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T10:00:10.000Z"));

    const { env } = createEnv();
    const runs = createRunCoordinator(env);

    const active = await runs.getStatus("telegram:777", {
      ...normalizeBotThreadState(undefined),
      runStatus: {
        running: true,
        startedAt: "2026-03-14T10:00:00.000Z",
        lastHeartbeatAt: "2026-03-14T10:00:05.000Z",
        cancelRequested: false,
        cancelRequestedAt: null,
        stoppedAt: null,
        workflowInstanceId: null,
      },
    });

    const stale = await runs.getStatus("telegram:778", {
      ...normalizeBotThreadState(undefined),
      runStatus: {
        running: true,
        startedAt: "2026-03-14T09:59:00.000Z",
        lastHeartbeatAt: "2026-03-14T09:59:50.000Z",
        cancelRequested: false,
        cancelRequestedAt: null,
        stoppedAt: null,
        workflowInstanceId: null,
      },
    });

    expect(active.busy).toBe("yes");
    expect(stale.busy).toBe("stale");

    vi.useRealTimers();
  });

  it("recovers thread state from persisted controls and workflow status", async () => {
    const { env } = createEnv();
    const runs = createRunCoordinator(env);

    await setPersistedThreadControls(env.DRECLAW_DB, "telegram:777", { verbose: true });
    await setPersistedRunStatus(env.DRECLAW_DB, "telegram:777", {
      running: true,
      startedAt: "2026-03-14T10:00:00.000Z",
      lastHeartbeatAt: "2026-03-14T10:00:05.000Z",
      cancelRequested: false,
      cancelRequestedAt: null,
      stoppedAt: null,
      workflowInstanceId: null,
    });
    await setPersistedWorkflowInstanceId(env.DRECLAW_DB, "telegram:777", "wf-123");

    const state = await runs.recoverState("telegram:777", normalizeBotThreadState(undefined));

    expect(state.verbose).toBe(true);
    expect(state.runStatus.running).toBe(true);
    expect(state.runStatus.workflowInstanceId).toBe("wf-123");
  });

  it("starts workflow runs through the coordinator boundary", async () => {
    const { env } = createEnv({
      CONVERSATION_WORKFLOW: {
        create: vi.fn(async ({ id }: { id: string; params: ConversationWorkflowPayload }) => ({
          id,
        })),
      } as unknown as Env["CONVERSATION_WORKFLOW"],
    });
    const runs = createRunCoordinator(env);
    const setState = vi.fn(async () => undefined);

    const workflowId = await runs.startWorkflowRun({
      thread: {
        id: "telegram:777",
        toJSON: () => ({ id: "telegram:777" }) as never,
        setState,
      } as never,
      message: {
        toJSON: () => ({ id: "message-1" }) as never,
      } as never,
      state: normalizeBotThreadState(undefined),
    });

    expect(workflowId).toBeTruthy();
    expect(setState).toHaveBeenCalledTimes(1);
    expect(
      (await getPersistedWorkflowInstanceId(env.DRECLAW_DB, "telegram:777"))?.length,
    ).toBeGreaterThan(0);
    expect((await getPersistedRunStatus(env.DRECLAW_DB, "telegram:777"))?.running).toBe(true);
  });

  it("requests stop, terminates workflow, and snapshots final state", async () => {
    const terminate = vi.fn(async () => undefined);
    const { env } = createEnv({
      CONVERSATION_WORKFLOW: {
        get: vi.fn(async () => ({ terminate })),
      } as unknown as Env["CONVERSATION_WORKFLOW"],
    });
    const runs = createRunCoordinator(env);

    await setPersistedRunStatus(env.DRECLAW_DB, "telegram:777", {
      running: true,
      startedAt: "2026-03-14T10:00:00.000Z",
      lastHeartbeatAt: "2026-03-14T10:00:05.000Z",
      cancelRequested: false,
      cancelRequestedAt: null,
      stoppedAt: null,
      workflowInstanceId: "wf-123",
    });
    await setPersistedWorkflowInstanceId(env.DRECLAW_DB, "telegram:777", "wf-123");

    const result = await runs.requestStop("telegram:777", normalizeBotThreadState(undefined));
    const persisted = await getPersistedRunStatus(env.DRECLAW_DB, "telegram:777");
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      "telegram:777",
    );

    expect(result.stopped).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(persisted?.running).toBe(false);
    expect(persisted?.workflowInstanceId).toBe(null);
    expect(persisted?.stoppedAt).toBeTruthy();
    expect(await getPersistedWorkflowInstanceId(env.DRECLAW_DB, "telegram:777")).toBe(null);
    expect(snapshot?.runStatus.workflowInstanceId).toBe(null);
    expect(snapshot?.runStatus.stoppedAt).toBeTruthy();
  });
});
