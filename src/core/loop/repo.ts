import { retryOnce } from "../../utils/retry";

export interface AgentRunRecord {
  id: string;
  updateId: number;
  chatId: number;
  payloadJson: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  attempts: number;
  resultText: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface ChatInboxRecord {
  id: string;
  chatId: number;
  updateId: number;
  payloadJson: string;
  createdAt: string;
  consumedAt: string | null;
  consumedByRunId: string | null;
}

export interface PersistedRunStatus {
  running: boolean;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  cancelRequested: boolean;
  cancelRequestedAt: string | null;
  stoppedAt: string | null;
  workflowInstanceId: string | null;
}

export interface PersistedThreadControls {
  verbose: boolean;
  thinking?: boolean;
  reasoning?: boolean;
  modelAlias?: string | null;
}

export async function getThreadStateSnapshot<T>(
  db: D1Database,
  threadId: string,
): Promise<T | null> {
  return getChatStateValue<T>(db, threadStateKey(threadId));
}

export async function setThreadStateSnapshot<T>(
  db: D1Database,
  threadId: string,
  value: T,
): Promise<void> {
  await setChatStateValue(db, threadStateKey(threadId), value);
}

export async function getPersistedRunStatus(
  db: D1Database,
  threadId: string,
): Promise<PersistedRunStatus | null> {
  return getChatStateValue<PersistedRunStatus>(db, runStatusKey(threadId));
}

export async function setPersistedRunStatus(
  db: D1Database,
  threadId: string,
  value: PersistedRunStatus,
): Promise<void> {
  await setChatStateValue(db, runStatusKey(threadId), value);
}

export async function clearPersistedRunStatus(db: D1Database, threadId: string): Promise<void> {
  await deleteChatStateValue(db, runStatusKey(threadId));
}

export async function requestPersistedRunStop(
  db: D1Database,
  threadId: string,
): Promise<PersistedRunStatus | null> {
  const current = await getPersistedRunStatus(db, threadId);
  if (!current) return null;
  const nowIso = new Date().toISOString();
  const next: PersistedRunStatus = { ...current, cancelRequested: true, cancelRequestedAt: nowIso };
  await setPersistedRunStatus(db, threadId, next);
  return next;
}

export async function finalizePersistedRunStop(
  db: D1Database,
  threadId: string,
): Promise<PersistedRunStatus | null> {
  const current = await getPersistedRunStatus(db, threadId);
  if (!current) return null;
  const nowIso = new Date().toISOString();
  const next: PersistedRunStatus = {
    ...current,
    running: false,
    cancelRequested: false,
    cancelRequestedAt: current.cancelRequestedAt,
    stoppedAt: nowIso,
    workflowInstanceId: null,
  };
  await setPersistedRunStatus(db, threadId, next);
  return next;
}

export async function getPersistedThreadControls(
  db: D1Database,
  threadId: string,
): Promise<PersistedThreadControls | null> {
  return getChatStateValue<PersistedThreadControls>(db, threadControlsKey(threadId));
}

export async function setPersistedThreadControls(
  db: D1Database,
  threadId: string,
  value: PersistedThreadControls,
): Promise<void> {
  await setChatStateValue(db, threadControlsKey(threadId), value);
}

export async function getPersistedWorkflowInstanceId(
  db: D1Database,
  threadId: string,
): Promise<string | null> {
  const value = await getChatStateValue<{ workflowInstanceId?: string }>(
    db,
    workflowInstanceKey(threadId),
  );
  return typeof value?.workflowInstanceId === "string" && value.workflowInstanceId.trim()
    ? value.workflowInstanceId
    : null;
}

export async function setPersistedWorkflowInstanceId(
  db: D1Database,
  threadId: string,
  workflowInstanceId: string,
): Promise<void> {
  await setChatStateValue(db, workflowInstanceKey(threadId), { workflowInstanceId });
}

export async function clearPersistedWorkflowInstanceId(
  db: D1Database,
  threadId: string,
): Promise<void> {
  await deleteChatStateValue(db, workflowInstanceKey(threadId));
}

export async function createAgentRun(
  db: D1Database,
  input: { id: string; updateId: number; chatId: number; payloadJson: string; nowIso: string },
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "INSERT OR IGNORE INTO agent_runs (id, update_id, chat_id, payload_json, status, attempts, result_text, error_message, created_at, updated_at, delivered_at) VALUES (?, ?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, NULL)",
      )
      .bind(input.id, input.updateId, input.chatId, input.payloadJson, input.nowIso, input.nowIso)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function getActiveAgentRunForChat(
  db: D1Database,
  chatId: number,
): Promise<AgentRunRecord | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT id, update_id, chat_id, payload_json, status, attempts, result_text, error_message, created_at, updated_at, delivered_at FROM agent_runs WHERE chat_id = ? AND status IN ('queued', 'running') ORDER BY created_at ASC LIMIT 1",
      )
      .bind(chatId)
      .first<Record<string, unknown>>();
    return row ? mapAgentRunRecord(row) : null;
  }, 150);
}

export async function enqueueChatInboxMessage(
  db: D1Database,
  input: { id: string; chatId: number; updateId: number; textJson: string; nowIso: string },
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "INSERT OR IGNORE INTO chat_inbox (id, chat_id, update_id, text_json, created_at, consumed_at, consumed_by_run_id) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
      )
      .bind(input.id, input.chatId, input.updateId, input.textJson, input.nowIso)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function claimChatInboxMessages(
  db: D1Database,
  input: { chatId: number; runId: string; limit: number; nowIso: string },
): Promise<ChatInboxRecord[]> {
  return retryOnce(async () => {
    const rows = await db
      .prepare(
        "SELECT id, chat_id, update_id, text_json, created_at, consumed_at, consumed_by_run_id FROM chat_inbox WHERE chat_id = ? AND consumed_at IS NULL ORDER BY created_at ASC LIMIT ?",
      )
      .bind(input.chatId, input.limit)
      .all<Record<string, unknown>>();
    const records = (rows.results ?? []).map(mapChatInboxRecord);
    for (const record of records) {
      await db
        .prepare(
          "UPDATE chat_inbox SET consumed_at = ?, consumed_by_run_id = ? WHERE id = ? AND consumed_at IS NULL",
        )
        .bind(input.nowIso, input.runId, record.id)
        .run();
    }
    return records;
  }, 150);
}

export async function clearPendingChatInbox(
  db: D1Database,
  chatId: number,
  nowIso: string,
): Promise<number> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE chat_inbox SET consumed_at = ?, consumed_by_run_id = 'cancelled' WHERE chat_id = ? AND consumed_at IS NULL",
      )
      .bind(nowIso, chatId)
      .run();
    return Number(result.meta.changes ?? 0);
  }, 150);
}

export async function releaseClaimedChatInboxMessage(
  db: D1Database,
  input: { id: string; runId: string },
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE chat_inbox SET consumed_at = NULL, consumed_by_run_id = NULL WHERE id = ? AND consumed_by_run_id = ?",
      )
      .bind(input.id, input.runId)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function getAgentRun(db: D1Database, id: string): Promise<AgentRunRecord | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT id, update_id, chat_id, payload_json, status, attempts, result_text, error_message, created_at, updated_at, delivered_at FROM agent_runs WHERE id = ?",
      )
      .bind(id)
      .first<Record<string, unknown>>();
    return row ? mapAgentRunRecord(row) : null;
  }, 150);
}

export async function markAgentRunRunning(
  db: D1Database,
  id: string,
  nowIso: string,
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE agent_runs SET status = 'running', error_message = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')",
      )
      .bind(nowIso, id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function markAgentRunCompleted(
  db: D1Database,
  id: string,
  resultText: string,
  nowIso: string,
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE agent_runs SET status = 'completed', result_text = ?, error_message = NULL, updated_at = ? WHERE id = ?",
      )
      .bind(resultText, nowIso, id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function markAgentRunRetryableFailure(
  db: D1Database,
  id: string,
  errorMessage: string,
  nowIso: string,
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE agent_runs SET status = 'queued', attempts = attempts + 1, error_message = ?, updated_at = ? WHERE id = ?",
      )
      .bind(errorMessage, nowIso, id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function updateAgentRunPayload(
  db: D1Database,
  id: string,
  payloadJson: string,
  nowIso: string,
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE agent_runs SET status = 'queued', payload_json = ?, updated_at = ? WHERE id = ?",
      )
      .bind(payloadJson, nowIso, id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function claimAgentRunDelivery(
  db: D1Database,
  id: string,
  nowIso: string,
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE agent_runs SET delivered_at = ?, updated_at = ? WHERE id = ? AND delivered_at IS NULL",
      )
      .bind(nowIso, nowIso, id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function cancelActiveRunsForChat(
  db: D1Database,
  chatId: number,
  nowIso: string,
): Promise<number> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE chat_id = ? AND status IN ('queued', 'running')",
      )
      .bind(nowIso, chatId)
      .run();
    return Number(result.meta.changes ?? 0);
  }, 150);
}

async function getChatStateValue<T>(db: D1Database, key: string): Promise<T | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare("SELECT value_json FROM chat_state_kv WHERE key = ?")
      .bind(key)
      .first<Record<string, unknown>>();
    if (!row?.value_json || typeof row.value_json !== "string") return null;
    return JSON.parse(row.value_json) as T;
  }, 150);
}

async function setChatStateValue<T>(db: D1Database, key: string, value: T): Promise<void> {
  const nowIso = new Date().toISOString();
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO chat_state_kv (key, value_json, expires_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, expires_at = NULL, updated_at = excluded.updated_at",
      )
      .bind(key, JSON.stringify(value), null, nowIso)
      .run();
  }, 150);
}

async function deleteChatStateValue(db: D1Database, key: string): Promise<void> {
  await retryOnce(async () => {
    await db.prepare("DELETE FROM chat_state_kv WHERE key = ?").bind(key).run();
  }, 150);
}

function threadStateKey(threadId: string): string {
  return `thread-state:${threadId}`;
}
function runStatusKey(threadId: string): string {
  return `run-status:${threadId}`;
}
function threadControlsKey(threadId: string): string {
  return `thread-controls:${threadId}`;
}
function workflowInstanceKey(threadId: string): string {
  return `workflow-instance:${threadId}`;
}

function mapAgentRunRecord(row: Record<string, unknown>): AgentRunRecord {
  const status = toStringValue(row.status, "queued");
  const normalizedStatus: AgentRunRecord["status"] =
    status === "running" || status === "completed" || status === "failed" || status === "cancelled"
      ? status
      : "queued";
  return {
    id: toStringValue(row.id),
    updateId: Number(row.update_id ?? 0),
    chatId: Number(row.chat_id ?? 0),
    payloadJson: toStringValue(row.payload_json, "{}"),
    status: normalizedStatus,
    attempts: Number(row.attempts ?? 0),
    resultText: toNullableStringValue(row.result_text),
    errorMessage: toNullableStringValue(row.error_message),
    createdAt: toStringValue(row.created_at),
    updatedAt: toStringValue(row.updated_at),
    deliveredAt: toNullableStringValue(row.delivered_at),
  };
}

function mapChatInboxRecord(row: Record<string, unknown>): ChatInboxRecord {
  return {
    id: toStringValue(row.id),
    chatId: Number(row.chat_id ?? 0),
    updateId: Number(row.update_id ?? 0),
    payloadJson: toStringValue(row.text_json, "{}"),
    createdAt: toStringValue(row.created_at),
    consumedAt: toNullableStringValue(row.consumed_at),
    consumedByRunId: toNullableStringValue(row.consumed_by_run_id),
  };
}

function toStringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return fallback;
}

function toNullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toStringValue(value);
}
