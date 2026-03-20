import { describe, expect, it } from "vite-plus/test";
import { createRemindersService } from "../../../src/plugins/reminders";
import { createEnv } from "../../helpers/fakes";

describe("reminders service supporting coverage", () => {
  it("claims due open reminders and skips completed reminders", async () => {
    const { env } = createEnv();
    const reminders = createRemindersService(env.DRECLAW_DB, { timezone: "UTC" });

    const open = await reminders.update(
      {
        action: "create",
        item: {
          title: "Open reminder",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );
    const completed = await reminders.update(
      {
        action: "create",
        item: {
          title: "Completed reminder",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );

    await reminders.update(
      {
        action: "complete",
        itemId: (completed as { item: { id: string } }).item.id,
      },
      { sourceChatId: 777 },
    );

    const claimed = await reminders.claimDue({ nowIso: "2000-01-02T00:00:00.000Z", limit: 10 });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe((open as { item: { id: string } }).item.id);
  });

  it("does not claim the same reminder twice while its claim is active", async () => {
    const { env } = createEnv();
    const reminders = createRemindersService(env.DRECLAW_DB, { timezone: "UTC" });

    await reminders.update(
      {
        action: "create",
        item: {
          title: "Claim once",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );

    const first = await reminders.claimDue({ nowIso: "2000-01-02T00:00:00.000Z", limit: 10 });
    const second = await reminders.claimDue({ nowIso: "2000-01-02T00:00:00.000Z", limit: 10 });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("finalizes one-time reminders as done and clears active claim state", async () => {
    const { env } = createEnv();
    const reminders = createRemindersService(env.DRECLAW_DB, { timezone: "UTC" });

    const created = await reminders.update(
      {
        action: "create",
        item: {
          title: "Finish reminder",
          nextWakeAt: "2000-01-01T00:00:00.000Z",
        },
      },
      { sourceChatId: 777 },
    );
    const reminderId = (created as { item: { id: string } }).item.id;
    const claimed = (
      await reminders.claimDue({
        nowIso: "2000-01-02T00:00:00.000Z",
        limit: 10,
      })
    )[0];
    if (!claimed?.claimToken || !claimed.nextWakeAt) throw new Error("Expected claimed reminder");

    const runId = await reminders.openWakeRun({
      reminderId,
      scheduledFor: claimed.nextWakeAt,
    });
    await reminders.finalizeWake({
      itemId: reminderId,
      claimToken: claimed.claimToken,
      runId,
      scheduledFor: claimed.nextWakeAt,
      outcome: "sent_message",
      summary: "Sent the reminder.",
    });

    const item = await reminders.getItem(reminderId);
    const runs = await reminders.listRecentWakeRuns(reminderId, 5);

    expect(item).toMatchObject({
      id: reminderId,
      status: "done",
      nextWakeAt: null,
      claimedAt: null,
      claimToken: null,
      workflowId: null,
    });
    expect(runs[0]).toMatchObject({
      id: runId,
      outcome: "completed",
      summary: "Sent the reminder.",
      nextWakeAt: null,
    });
  });
});
