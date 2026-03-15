import { retryOnce } from "../../utils/retry";
import type {
  ReminderQueryFilter,
  Reminder,
  ReminderOutcome,
  ReminderProfile,
  ReminderRun,
} from "./types";

export async function getReminderProfile(db: D1Database): Promise<ReminderProfile | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare("SELECT timezone, primary_chat_id, updated_at FROM reminders_profile WHERE id = 1")
      .first<Record<string, unknown>>();
    return row ? mapReminderProfile(row) : null;
  }, 150);
}

export async function upsertReminderProfile(
  db: D1Database,
  input: { timezone: string; primaryChatId: number | null; updatedAt: string },
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO reminders_profile (id, timezone, primary_chat_id, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone, primary_chat_id = COALESCE(excluded.primary_chat_id, reminders_profile.primary_chat_id), updated_at = excluded.updated_at",
      )
      .bind(input.timezone, input.primaryChatId, input.updatedAt)
      .run();
  }, 150);
}

export async function insertReminder(
  db: D1Database,
  input: {
    id: string;
    kind: string;
    title: string;
    notes: string;
    status: string;
    priority: number;
    scheduleJson: string | null;
    nextWakeAt: string | null;
    lastWakeAt: string | null;
    snoozeUntil: string | null;
    sourceChatId: number | null;
    createdAt: string;
    updatedAt: string;
  },
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO reminders_items (id, kind, title, notes, status, priority, schedule_json, next_wake_at, last_wake_at, snooze_until, source_chat_id, claimed_at, claim_token, workflow_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
      )
      .bind(
        input.id,
        input.kind,
        input.title,
        input.notes,
        input.status,
        input.priority,
        input.scheduleJson,
        input.nextWakeAt,
        input.lastWakeAt,
        input.snoozeUntil,
        input.sourceChatId,
        input.createdAt,
        input.updatedAt,
      )
      .run();
  }, 150);
}

export async function getReminder(db: D1Database, id: string): Promise<Reminder | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT id, kind, title, notes, status, priority, schedule_json, next_wake_at, last_wake_at, snooze_until, source_chat_id, claimed_at, claim_token, workflow_id, created_at, updated_at FROM reminders_items WHERE id = ?",
      )
      .bind(id)
      .first<Record<string, unknown>>();
    return row ? mapReminder(row) : null;
  }, 150);
}

export async function listReminders(
  db: D1Database,
  params: { filter?: ReminderQueryFilter; limit: number },
): Promise<Reminder[]> {
  const conditions: string[] = [];
  const binds: Array<string | number> = [];
  const filter = params.filter ?? {};
  if (filter.status) {
    conditions.push("status = ?");
    binds.push(filter.status);
  }
  if (filter.kind) {
    conditions.push("kind = ?");
    binds.push(filter.kind);
  }
  if (filter.sourceChatId != null) {
    conditions.push("source_chat_id = ?");
    binds.push(filter.sourceChatId);
  }
  if (filter.dueBefore) {
    conditions.push("next_wake_at IS NOT NULL AND next_wake_at <= ?");
    binds.push(filter.dueBefore);
  }
  if (filter.text?.trim()) {
    conditions.push("(title LIKE ? OR notes LIKE ?)");
    binds.push(`%${filter.text.trim()}%`, `%${filter.text.trim()}%`);
  }
  binds.push(Math.max(1, Math.min(100, Math.trunc(params.limit))));
  const sql = [
    "SELECT id, kind, title, notes, status, priority, schedule_json, next_wake_at, last_wake_at, snooze_until, source_chat_id, claimed_at, claim_token, workflow_id, created_at, updated_at FROM reminders_items",
    conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    "ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, priority ASC, COALESCE(next_wake_at, updated_at) ASC LIMIT ?",
  ]
    .filter(Boolean)
    .join(" ");
  return retryOnce(async () => {
    const rows = await db
      .prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapReminder);
  }, 150);
}

export async function updateReminder(
  db: D1Database,
  input: {
    id: string;
    kind?: string;
    title?: string;
    notes?: string;
    status?: string;
    priority?: number;
    scheduleJson?: string | null;
    nextWakeAt?: string | null;
    lastWakeAt?: string | null;
    snoozeUntil?: string | null;
    sourceChatId?: number | null;
    claimedAt?: string | null;
    claimToken?: string | null;
    workflowId?: string | null;
    updatedAt: string;
  },
): Promise<boolean> {
  const fields: string[] = [];
  const binds: Array<string | number | null> = [];
  for (const [column, value] of [
    ["kind", input.kind],
    ["title", input.title],
    ["notes", input.notes],
    ["status", input.status],
    ["priority", input.priority],
    ["schedule_json", input.scheduleJson],
    ["next_wake_at", input.nextWakeAt],
    ["last_wake_at", input.lastWakeAt],
    ["snooze_until", input.snoozeUntil],
    ["source_chat_id", input.sourceChatId],
    ["claimed_at", input.claimedAt],
    ["claim_token", input.claimToken],
    ["workflow_id", input.workflowId],
  ] as Array<[string, unknown]>) {
    if (value === undefined) continue;
    fields.push(`${column} = ?`);
    binds.push(value as string | number | null);
  }
  fields.push("updated_at = ?");
  binds.push(input.updatedAt, input.id);
  return retryOnce(async () => {
    const result = await db
      .prepare(`UPDATE reminders_items SET ${fields.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function claimDueReminder(
  db: D1Database,
  input: { id: string; nowIso: string; claimToken: string; staleBeforeIso: string },
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE reminders_items SET claimed_at = ?, claim_token = ?, updated_at = ? WHERE id = ? AND status = 'open' AND next_wake_at IS NOT NULL AND next_wake_at <= ? AND (claimed_at IS NULL OR claimed_at < ?) AND workflow_id IS NULL",
      )
      .bind(
        input.nowIso,
        input.claimToken,
        input.nowIso,
        input.id,
        input.nowIso,
        input.staleBeforeIso,
      )
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function listDueReminders(
  db: D1Database,
  input: { nowIso: string; limit: number },
): Promise<Reminder[]> {
  return retryOnce(async () => {
    const rows = await db
      .prepare(
        "SELECT id, kind, title, notes, status, priority, schedule_json, next_wake_at, last_wake_at, snooze_until, source_chat_id, claimed_at, claim_token, workflow_id, created_at, updated_at FROM reminders_items WHERE status = 'open' AND next_wake_at IS NOT NULL AND next_wake_at <= ? AND workflow_id IS NULL ORDER BY priority ASC, next_wake_at ASC LIMIT ?",
      )
      .bind(input.nowIso, input.limit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapReminder);
  }, 150);
}

export async function attachReminderWorkflow(
  db: D1Database,
  input: { id: string; claimToken: string; workflowId: string; updatedAt: string },
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE reminders_items SET workflow_id = ?, updated_at = ? WHERE id = ? AND claim_token = ?",
      )
      .bind(input.workflowId, input.updatedAt, input.id, input.claimToken)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function clearReminderClaim(
  db: D1Database,
  input: { id: string; claimToken: string; updatedAt: string },
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE reminders_items SET claimed_at = NULL, claim_token = NULL, workflow_id = NULL, updated_at = ? WHERE id = ? AND claim_token = ?",
      )
      .bind(input.updatedAt, input.id, input.claimToken)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function insertReminderRun(
  db: D1Database,
  input: {
    id: string;
    reminderId: string;
    scheduledFor: string;
    startedAt: string;
  },
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO reminders_wake_runs (id, reminder_id, scheduled_for, started_at, finished_at, outcome, summary, error, next_wake_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
      )
      .bind(input.id, input.reminderId, input.scheduledFor, input.startedAt)
      .run();
  }, 150);
}

export async function finishReminderRun(
  db: D1Database,
  input: {
    id: string;
    finishedAt: string;
    outcome: ReminderOutcome;
    summary: string | null;
    error: string | null;
    nextWakeAt: string | null;
  },
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE reminders_wake_runs SET finished_at = ?, outcome = ?, summary = ?, error = ?, next_wake_at = ? WHERE id = ?",
      )
      .bind(input.finishedAt, input.outcome, input.summary, input.error, input.nextWakeAt, input.id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function listRecentReminderRuns(
  db: D1Database,
  input: { reminderId: string; limit: number },
): Promise<ReminderRun[]> {
  return retryOnce(async () => {
    const rows = await db
      .prepare(
        "SELECT id, reminder_id, scheduled_for, started_at, finished_at, outcome, summary, error, next_wake_at FROM reminders_wake_runs WHERE reminder_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .bind(input.reminderId, input.limit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapReminderRun);
  }, 150);
}

function mapReminderProfile(row: Record<string, unknown>): ReminderProfile {
  return {
    timezone: stringValue(row.timezone, "UTC"),
    primaryChatId: row.primary_chat_id == null ? null : Number(row.primary_chat_id),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapReminder(row: Record<string, unknown>): Reminder {
  return {
    id: stringValue(row.id),
    kind: stringValue(row.kind, "follow_up"),
    title: stringValue(row.title),
    notes: stringValue(row.notes),
    status: normalizeStatus(row.status),
    priority: Number(row.priority ?? 3),
    schedule: parseSchedule(row.schedule_json),
    nextWakeAt: nullableString(row.next_wake_at),
    lastWakeAt: nullableString(row.last_wake_at),
    snoozeUntil: nullableString(row.snooze_until),
    sourceChatId: row.source_chat_id == null ? null : Number(row.source_chat_id),
    claimedAt: nullableString(row.claimed_at),
    claimToken: nullableString(row.claim_token),
    workflowId: nullableString(row.workflow_id),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function mapReminderRun(row: Record<string, unknown>): ReminderRun {
  return {
    id: stringValue(row.id),
    reminderId: stringValue(row.reminder_id),
    scheduledFor: stringValue(row.scheduled_for),
    startedAt: stringValue(row.started_at),
    finishedAt: nullableString(row.finished_at),
    outcome: normalizeOutcome(row.outcome),
    summary: nullableString(row.summary),
    error: nullableString(row.error),
    nextWakeAt: nullableString(row.next_wake_at),
  };
}

function parseSchedule(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeStatus(value: unknown): Reminder["status"] {
  return value === "done" || value === "cancelled" ? value : "open";
}

function normalizeOutcome(value: unknown): ReminderRun["outcome"] {
  return value === "sent_message" ||
    value === "silent" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "failed"
    ? value
    : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
