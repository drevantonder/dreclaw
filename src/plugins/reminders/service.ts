import {
  attachReminderWorkflow,
  claimDueReminder,
  clearReminderClaim,
  finishReminderRun,
  getReminder,
  getReminderProfile,
  insertReminder,
  insertReminderRun,
  listReminders,
  listDueReminders,
  listRecentReminderRuns,
  updateReminder,
  upsertReminderProfile,
} from "./repo";
import { computeNextWakeAt, isValidTimezone } from "./schedule";
import type {
  ReminderQueryFilter,
  ReminderUpdateInput,
  Reminder,
  ReminderOutcome,
  ReminderProfile,
} from "./types";

export class RemindersService {
  constructor(
    private readonly db: D1Database,
    private readonly defaults: { timezone: string; primaryChatId?: number | null } = {
      timezone: "UTC",
    },
  ) {}

  async ensureProfile(input?: {
    timezone?: string | null;
    primaryChatId?: number | null;
  }): Promise<ReminderProfile> {
    const current = await getReminderProfile(this.db);
    const timezone = normalizeTimezone(
      input?.timezone,
      current?.timezone ?? this.defaults.timezone,
    );
    const primaryChatId =
      input?.primaryChatId ?? current?.primaryChatId ?? this.defaults.primaryChatId ?? null;
    const updatedAt = new Date().toISOString();
    await upsertReminderProfile(this.db, { timezone, primaryChatId, updatedAt });
    return { timezone, primaryChatId, updatedAt };
  }

  async query(filter?: ReminderQueryFilter, limit = 20): Promise<Reminder[]> {
    return listReminders(this.db, { filter, limit });
  }

  async getItem(id: string): Promise<Reminder | null> {
    return getReminder(this.db, id);
  }

  async update(input: ReminderUpdateInput, context?: { sourceChatId?: number | null }) {
    const profile = await this.ensureProfile({ primaryChatId: context?.sourceChatId ?? null });
    const nowIso = new Date().toISOString();

    switch (input.action) {
      case "create": {
        const itemId = crypto.randomUUID();
        const nextWakeAt = resolveRequestedNextWakeAt({
          nextWakeAt: input.item.nextWakeAt ?? null,
          schedule: input.item.schedule ?? null,
          timezone: profile.timezone,
          nowIso,
        });
        await insertReminder(this.db, {
          id: itemId,
          kind: (input.item.kind ?? "follow_up").trim() || "follow_up",
          title: input.item.title.trim(),
          notes: (input.item.notes ?? "").trim(),
          status: "open",
          priority: normalizePriority(input.item.priority),
          scheduleJson: stringifySchedule(input.item.schedule ?? null),
          nextWakeAt,
          lastWakeAt: null,
          snoozeUntil: null,
          sourceChatId: input.item.sourceChatId ?? context?.sourceChatId ?? null,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        return { item: await this.requireItem(itemId) };
      }
      case "patch": {
        const current = await this.requireItem(input.itemId);
        const nextWakeAt =
          input.patch.nextWakeAt !== undefined || input.patch.schedule !== undefined
            ? resolveRequestedNextWakeAt({
                nextWakeAt: input.patch.nextWakeAt ?? null,
                schedule: input.patch.schedule ?? current.schedule,
                timezone: profile.timezone,
                nowIso,
              })
            : undefined;
        await updateReminder(this.db, {
          id: current.id,
          kind: normalizeOptionalString(input.patch.kind),
          title: normalizeOptionalString(input.patch.title),
          notes: input.patch.notes === undefined ? undefined : input.patch.notes.trim(),
          status: input.patch.status,
          priority:
            input.patch.priority === undefined
              ? undefined
              : normalizePriority(input.patch.priority),
          scheduleJson:
            input.patch.schedule === undefined
              ? undefined
              : stringifySchedule(input.patch.schedule ?? null),
          nextWakeAt,
          sourceChatId:
            input.patch.sourceChatId === undefined ? undefined : (input.patch.sourceChatId ?? null),
          updatedAt: nowIso,
        });
        return { item: await this.requireItem(current.id) };
      }
      case "complete":
      case "cancel": {
        await updateReminder(this.db, {
          id: input.itemId,
          status: input.action === "complete" ? "done" : "cancelled",
          nextWakeAt: null,
          snoozeUntil: null,
          updatedAt: nowIso,
        });
        return { item: await this.requireItem(input.itemId) };
      }
      case "snooze":
      case "reschedule": {
        await updateReminder(this.db, {
          id: input.itemId,
          nextWakeAt: normalizeIso(input.nextWakeAt),
          snoozeUntil: input.action === "snooze" ? normalizeIso(input.nextWakeAt) : null,
          updatedAt: nowIso,
        });
        return { item: await this.requireItem(input.itemId) };
      }
      case "append_note": {
        const current = await this.requireItem(input.itemId);
        const nextNotes = [current.notes, input.note.trim()].filter(Boolean).join("\n\n");
        await updateReminder(this.db, {
          id: current.id,
          notes: nextNotes,
          updatedAt: nowIso,
        });
        return { item: await this.requireItem(current.id) };
      }
    }
  }

  async claimDue(params?: { nowIso?: string; limit?: number }) {
    const nowIso = params?.nowIso ?? new Date().toISOString();
    const staleBeforeIso = new Date(Date.parse(nowIso) - 10 * 60_000).toISOString();
    const candidates = await listDueReminders(this.db, {
      nowIso,
      limit: Math.max(1, Math.min(50, Math.trunc(params?.limit ?? 10))),
    });
    const claimed: Reminder[] = [];
    for (const item of candidates) {
      const claimToken = crypto.randomUUID();
      const ok = await claimDueReminder(this.db, {
        id: item.id,
        nowIso,
        claimToken,
        staleBeforeIso,
      });
      if (!ok) continue;
      const refreshed = await getReminder(this.db, item.id);
      if (refreshed) claimed.push(refreshed);
    }
    return claimed;
  }

  async markWorkflowStarted(params: { id: string; claimToken: string; workflowId: string }) {
    const updatedAt = new Date().toISOString();
    return attachReminderWorkflow(this.db, { ...params, updatedAt });
  }

  async releaseClaim(params: { id: string; claimToken: string }) {
    return clearReminderClaim(this.db, {
      ...params,
      updatedAt: new Date().toISOString(),
    });
  }

  async openWakeRun(params: { reminderId: string; scheduledFor: string }) {
    const id = crypto.randomUUID();
    await insertReminderRun(this.db, {
      id,
      reminderId: params.reminderId,
      scheduledFor: params.scheduledFor,
      startedAt: new Date().toISOString(),
    });
    return id;
  }

  async listRecentWakeRuns(reminderId: string, limit = 5) {
    return listRecentReminderRuns(this.db, { reminderId, limit });
  }

  async finalizeWake(params: {
    itemId: string;
    claimToken: string;
    runId: string;
    scheduledFor: string;
    outcome: ReminderOutcome;
    summary: string | null;
    error?: string | null;
  }) {
    const profile = await this.ensureProfile();
    const item = await this.requireItem(params.itemId);
    const nowIso = new Date().toISOString();
    let nextWakeAt = item.nextWakeAt;
    let status = item.status;
    const schedulingUnchanged = item.nextWakeAt === params.scheduledFor && item.snoozeUntil == null;

    if (item.status === "open" && schedulingUnchanged) {
      if (item.schedule?.type === "recurring") {
        nextWakeAt = computeNextWakeAt({
          schedule: item.schedule,
          timezone: profile.timezone,
          afterIso: maxIso(nowIso, params.scheduledFor),
        });
      } else {
        nextWakeAt = null;
        status = "done";
      }
      await updateReminder(this.db, {
        id: item.id,
        status,
        nextWakeAt,
        lastWakeAt: params.scheduledFor,
        snoozeUntil: null,
        claimedAt: null,
        claimToken: null,
        workflowId: null,
        updatedAt: nowIso,
      });
    } else {
      await updateReminder(this.db, {
        id: item.id,
        lastWakeAt: params.scheduledFor,
        claimedAt: null,
        claimToken: null,
        workflowId: null,
        updatedAt: nowIso,
      });
    }

    const refreshed = await this.requireItem(item.id);
    await finishReminderRun(this.db, {
      id: params.runId,
      finishedAt: nowIso,
      outcome:
        refreshed.status === "cancelled"
          ? "cancelled"
          : refreshed.status === "done"
            ? "completed"
            : params.outcome,
      summary: params.summary,
      error: params.error ?? null,
      nextWakeAt: refreshed.nextWakeAt,
    });
    return refreshed;
  }

  private async requireItem(id: string) {
    const item = await getReminder(this.db, id);
    if (!item) throw new Error(`Reminder not found: ${id}`);
    return item;
  }
}

export function createRemindersService(
  db: D1Database,
  defaults?: { timezone?: string; primaryChatId?: number | null },
) {
  return new RemindersService(db, {
    timezone: normalizeTimezone(defaults?.timezone, "UTC"),
    primaryChatId: defaults?.primaryChatId ?? null,
  });
}

function stringifySchedule(value: Reminder["schedule"] | null | undefined) {
  return value == null ? null : JSON.stringify(value);
}

function normalizePriority(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(5, Math.trunc(Number(value))));
}

function normalizeOptionalString(value: string | undefined) {
  return value === undefined ? undefined : value.trim();
}

function normalizeTimezone(input: string | null | undefined, fallback: string): string {
  return input && isValidTimezone(input) ? input : fallback;
}

function resolveRequestedNextWakeAt(params: {
  nextWakeAt: string | null;
  schedule: Reminder["schedule"] | null;
  timezone: string;
  nowIso: string;
}) {
  if (params.nextWakeAt) return normalizeIso(params.nextWakeAt);
  if (!params.schedule) return null;
  return computeNextWakeAt({
    schedule: params.schedule,
    timezone: params.timezone,
    afterIso: params.nowIso,
  });
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO datetime: ${value}`);
  return new Date(parsed).toISOString();
}

function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
