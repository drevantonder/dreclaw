import { retryOnce } from "./retry";

export type { MemoryEpisodeRecord, MemoryFactRecord } from "./core/memory/repo";
export {
  attachMemoryFactSource,
  createMemoryFact,
  deleteMemoryFactById,
  deleteMemoryForChat,
  deleteOldMemoryEpisodes,
  getActiveMemoryFactByTarget,
  insertMemoryEpisode,
  listActiveMemoryFacts,
  listMemoryFactsByIds,
  listRecentMemoryEpisodes,
  listUnprocessedMemoryEpisodes,
  markMemoryEpisodesProcessed,
  searchMemoryFactsKeyword,
  supersedeMemoryFact,
  upsertSimilarMemoryFact,
} from "./core/memory/repo";
export type { GoogleOAuthStateRecord, GoogleOAuthTokenRecord } from "./integrations/google/repo";
export {
  createGoogleOAuthState,
  deleteGoogleOAuthToken,
  getGoogleOAuthState,
  getGoogleOAuthToken,
  markGoogleOAuthStateUsed,
  upsertGoogleOAuthToken,
} from "./integrations/google/repo";

export interface VfsEntryRecord {
  path: string;
  content: string;
  sizeBytes: number;
  sha256: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PutVfsEntryInput {
  path: string;
  content: string;
  sizeBytes: number;
  sha256: string;
  nowIso: string;
  overwrite: boolean;
}

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
  textJson: string;
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
}

export async function markUpdateSeen(db: D1Database, updateId: number): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?)")
      .bind(updateId, new Date().toISOString())
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
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
  const next: PersistedRunStatus = {
    ...current,
    cancelRequested: true,
    cancelRequestedAt: nowIso,
  };
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

export async function getVfsRevision(db: D1Database): Promise<number> {
  return retryOnce(async () => {
    const row = await db
      .prepare("SELECT revision FROM vfs_meta WHERE id = 1")
      .first<Record<string, unknown>>();
    if (row && row.revision !== null && row.revision !== undefined) {
      return Number(row.revision);
    }
    await db
      .prepare("INSERT OR IGNORE INTO vfs_meta (id, revision, updated_at) VALUES (1, 0, ?)")
      .bind(new Date().toISOString())
      .run();
    return 0;
  }, 150);
}

export async function countVfsEntries(db: D1Database): Promise<number> {
  return retryOnce(async () => {
    const row = await db
      .prepare("SELECT COUNT(*) AS count FROM vfs_entries WHERE deleted_at IS NULL")
      .first<Record<string, unknown>>();
    return Number(row?.count ?? 0);
  }, 150);
}

export async function listVfsEntries(
  db: D1Database,
  prefix: string,
  limit: number,
): Promise<VfsEntryRecord[]> {
  const normalizedPrefix = prefix || "/";
  return retryOnce(async () => {
    const rows = await db
      .prepare(
        "SELECT path, content, size_bytes, sha256, version, created_at, updated_at FROM vfs_entries WHERE deleted_at IS NULL AND path LIKE ? ORDER BY path ASC LIMIT ?",
      )
      .bind(`${normalizedPrefix}%`, limit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapVfsEntryRecord);
  }, 150);
}

export async function getVfsEntry(db: D1Database, path: string): Promise<VfsEntryRecord | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT path, content, size_bytes, sha256, version, created_at, updated_at FROM vfs_entries WHERE path = ? AND deleted_at IS NULL",
      )
      .bind(path)
      .first<Record<string, unknown>>();
    return row ? mapVfsEntryRecord(row) : null;
  }, 150);
}

export async function putVfsEntry(
  db: D1Database,
  input: PutVfsEntryInput,
): Promise<{ ok: true; entry: VfsEntryRecord } | { ok: false; code: "EEXIST" }> {
  return retryOnce(async () => {
    const existing = await db
      .prepare(
        "SELECT path, content, size_bytes, sha256, version, created_at, updated_at FROM vfs_entries WHERE path = ? AND deleted_at IS NULL",
      )
      .bind(input.path)
      .first<Record<string, unknown>>();

    if (existing && !input.overwrite) {
      return { ok: false as const, code: "EEXIST" as const };
    }

    const nextVersion = existing ? Number(existing.version ?? 0) + 1 : 1;
    const createdAt = existing ? toStringValue(existing.created_at, input.nowIso) : input.nowIso;

    await db
      .prepare(
        "INSERT INTO vfs_entries (path, content, size_bytes, sha256, version, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(path) DO UPDATE SET content = excluded.content, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, version = excluded.version, created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = NULL",
      )
      .bind(
        input.path,
        input.content,
        input.sizeBytes,
        input.sha256,
        nextVersion,
        createdAt,
        input.nowIso,
      )
      .run();

    const revision = await bumpVfsRevision(db, input.nowIso);
    void revision;
    return {
      ok: true,
      entry: {
        path: input.path,
        content: input.content,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        version: nextVersion,
        createdAt,
        updatedAt: input.nowIso,
      },
    };
  }, 150);
}

export async function deleteVfsEntry(
  db: D1Database,
  path: string,
  nowIso: string,
): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE vfs_entries SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE path = ? AND deleted_at IS NULL",
      )
      .bind(nowIso, nowIso, path)
      .run();
    const deleted = Boolean(result.meta.changes && result.meta.changes > 0);
    if (deleted) {
      await bumpVfsRevision(db, nowIso);
    }
    return deleted;
  }, 150);
}

export async function clearAllVfsEntries(db: D1Database, nowIso: string): Promise<number> {
  return retryOnce(async () => {
    const result = await db
      .prepare(
        "UPDATE vfs_entries SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE deleted_at IS NULL",
      )
      .bind(nowIso, nowIso)
      .run();
    const changes = Number(result.meta.changes ?? 0);
    if (changes > 0) {
      await bumpVfsRevision(db, nowIso);
    }
    return changes;
  }, 150);
}

export async function createAgentRun(
  db: D1Database,
  input: {
    id: string;
    updateId: number;
    chatId: number;
    payloadJson: string;
    nowIso: string;
  },
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
  input: {
    id: string;
    chatId: number;
    updateId: number;
    textJson: string;
    nowIso: string;
  },
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
  input: {
    chatId: number;
    runId: string;
    limit: number;
    nowIso: string;
  },
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

async function bumpVfsRevision(db: D1Database, nowIso: string): Promise<number> {
  await db
    .prepare("INSERT OR IGNORE INTO vfs_meta (id, revision, updated_at) VALUES (1, 0, ?)")
    .bind(nowIso)
    .run();
  await db
    .prepare("UPDATE vfs_meta SET revision = revision + 1, updated_at = ? WHERE id = 1")
    .bind(nowIso)
    .run();
  const row = await db
    .prepare("SELECT revision FROM vfs_meta WHERE id = 1")
    .first<Record<string, unknown>>();
  return Number(row?.revision ?? 0);
}

function mapVfsEntryRecord(row: Record<string, unknown>): VfsEntryRecord {
  return {
    path: toStringValue(row.path),
    content: toStringValue(row.content),
    sizeBytes: Number(row.size_bytes ?? 0),
    sha256: toStringValue(row.sha256),
    version: Number(row.version ?? 0),
    createdAt: toStringValue(row.created_at),
    updatedAt: toStringValue(row.updated_at),
  };
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
    textJson: toStringValue(row.text_json, "{}"),
    createdAt: toStringValue(row.created_at),
    consumedAt: toNullableStringValue(row.consumed_at),
    consumedByRunId: toNullableStringValue(row.consumed_by_run_id),
  };
}

function toStringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function toNullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toStringValue(value);
}
