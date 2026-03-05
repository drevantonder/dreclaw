import { retryOnce } from "./retry";

export interface GoogleOAuthStateRecord {
  state: string;
  chatId: number;
  telegramUserId: number;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface GoogleOAuthTokenRecord {
  principal: string;
  telegramUserId: number | null;
  refreshTokenCiphertext: string;
  nonce: string;
  scopes: string;
  updatedAt: string;
}

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

export interface MemoryEpisodeRecord {
  id: string;
  chatId: number;
  role: "user" | "assistant" | "tool";
  content: string;
  salience: number;
  createdAt: string;
  processedAt: string | null;
}

export interface MemoryFactRecord {
  id: string;
  chatId: number;
  kind: "preference" | "fact" | "goal" | "identity";
  text: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  supersededBy: string | null;
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

export async function createGoogleOAuthState(
  db: D1Database,
  state: Omit<GoogleOAuthStateRecord, "usedAt">,
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO google_oauth_states (state, chat_id, telegram_user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      )
      .bind(state.state, state.chatId, state.telegramUserId, state.expiresAt, state.createdAt)
      .run();
  }, 150);
}

export async function getGoogleOAuthState(db: D1Database, state: string): Promise<GoogleOAuthStateRecord | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT state, chat_id, telegram_user_id, expires_at, used_at, created_at FROM google_oauth_states WHERE state = ?",
      )
      .bind(state)
      .first<Record<string, unknown>>();
    return row ? mapGoogleOAuthStateRecord(row) : null;
  }, 150);
}

export async function markGoogleOAuthStateUsed(db: D1Database, state: string, usedAt: string): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("UPDATE google_oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL")
      .bind(usedAt, state)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function upsertGoogleOAuthToken(db: D1Database, token: GoogleOAuthTokenRecord): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO google_oauth_tokens (principal, telegram_user_id, refresh_token_ciphertext, nonce, scopes, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(principal) DO UPDATE SET telegram_user_id = excluded.telegram_user_id, refresh_token_ciphertext = excluded.refresh_token_ciphertext, nonce = excluded.nonce, scopes = excluded.scopes, updated_at = excluded.updated_at",
      )
      .bind(
        token.principal,
        token.telegramUserId,
        token.refreshTokenCiphertext,
        token.nonce,
        token.scopes,
        token.updatedAt,
      )
      .run();
  }, 150);
}

export async function getGoogleOAuthToken(db: D1Database, principal: string): Promise<GoogleOAuthTokenRecord | null> {
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT principal, telegram_user_id, refresh_token_ciphertext, nonce, scopes, updated_at FROM google_oauth_tokens WHERE principal = ?",
      )
      .bind(principal)
      .first<Record<string, unknown>>();
    return row ? mapGoogleOAuthTokenRecord(row) : null;
  }, 150);
}

export async function deleteGoogleOAuthToken(db: D1Database, principal: string): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db.prepare("DELETE FROM google_oauth_tokens WHERE principal = ?").bind(principal).run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function getVfsRevision(db: D1Database): Promise<number> {
  return retryOnce(async () => {
    const row = await db.prepare("SELECT revision FROM vfs_meta WHERE id = 1").first<Record<string, unknown>>();
    if (row && row.revision !== null && row.revision !== undefined) {
      return Number(row.revision);
    }
    await db.prepare("INSERT OR IGNORE INTO vfs_meta (id, revision, updated_at) VALUES (1, 0, ?)").bind(new Date().toISOString()).run();
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

export async function listVfsEntries(db: D1Database, prefix: string, limit: number): Promise<VfsEntryRecord[]> {
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
    const createdAt = existing ? String(existing.created_at ?? input.nowIso) : input.nowIso;

    await db
      .prepare(
        "INSERT INTO vfs_entries (path, content, size_bytes, sha256, version, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(path) DO UPDATE SET content = excluded.content, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, version = excluded.version, created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = NULL",
      )
      .bind(input.path, input.content, input.sizeBytes, input.sha256, nextVersion, createdAt, input.nowIso)
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

export async function deleteVfsEntry(db: D1Database, path: string, nowIso: string): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("UPDATE vfs_entries SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE path = ? AND deleted_at IS NULL")
      .bind(nowIso, nowIso, path)
      .run();
    const deleted = Boolean(result.meta.changes && result.meta.changes > 0);
    if (deleted) {
      await bumpVfsRevision(db, nowIso);
    }
    return deleted;
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

export async function markAgentRunRunning(db: D1Database, id: string, nowIso: string): Promise<boolean> {
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

export async function markAgentRunCompleted(db: D1Database, id: string, resultText: string, nowIso: string): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("UPDATE agent_runs SET status = 'completed', result_text = ?, error_message = NULL, updated_at = ? WHERE id = ?")
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
      .prepare("UPDATE agent_runs SET status = 'queued', attempts = attempts + 1, error_message = ?, updated_at = ? WHERE id = ?")
      .bind(errorMessage, nowIso, id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function updateAgentRunPayload(db: D1Database, id: string, payloadJson: string, nowIso: string): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("UPDATE agent_runs SET status = 'queued', payload_json = ?, updated_at = ? WHERE id = ?")
      .bind(payloadJson, nowIso, id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function claimAgentRunDelivery(db: D1Database, id: string, nowIso: string): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("UPDATE agent_runs SET delivered_at = ?, updated_at = ? WHERE id = ? AND delivered_at IS NULL")
      .bind(nowIso, nowIso, id)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function cancelActiveRunsForChat(db: D1Database, chatId: number, nowIso: string): Promise<number> {
  return retryOnce(async () => {
    const result = await db
      .prepare("UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE chat_id = ? AND status IN ('queued', 'running')")
      .bind(nowIso, chatId)
      .run();
    return Number(result.meta.changes ?? 0);
  }, 150);
}

function mapGoogleOAuthStateRecord(row: Record<string, unknown>): GoogleOAuthStateRecord {
  return {
    state: String(row.state ?? ""),
    chatId: Number(row.chat_id ?? 0),
    telegramUserId: Number(row.telegram_user_id ?? 0),
    expiresAt: String(row.expires_at ?? ""),
    usedAt: row.used_at === null || row.used_at === undefined ? null : String(row.used_at),
    createdAt: String(row.created_at ?? ""),
  };
}

function mapGoogleOAuthTokenRecord(row: Record<string, unknown>): GoogleOAuthTokenRecord {
  const rawUserId = row.telegram_user_id;
  const telegramUserId = rawUserId === null || rawUserId === undefined ? null : Number(rawUserId);
  return {
    principal: String(row.principal ?? ""),
    telegramUserId,
    refreshTokenCiphertext: String(row.refresh_token_ciphertext ?? ""),
    nonce: String(row.nonce ?? ""),
    scopes: String(row.scopes ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

async function bumpVfsRevision(db: D1Database, nowIso: string): Promise<number> {
  await db.prepare("INSERT OR IGNORE INTO vfs_meta (id, revision, updated_at) VALUES (1, 0, ?)").bind(nowIso).run();
  await db.prepare("UPDATE vfs_meta SET revision = revision + 1, updated_at = ? WHERE id = 1").bind(nowIso).run();
  const row = await db.prepare("SELECT revision FROM vfs_meta WHERE id = 1").first<Record<string, unknown>>();
  return Number(row?.revision ?? 0);
}

function mapVfsEntryRecord(row: Record<string, unknown>): VfsEntryRecord {
  return {
    path: String(row.path ?? ""),
    content: String(row.content ?? ""),
    sizeBytes: Number(row.size_bytes ?? 0),
    sha256: String(row.sha256 ?? ""),
    version: Number(row.version ?? 0),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapAgentRunRecord(row: Record<string, unknown>): AgentRunRecord {
  const status = String(row.status ?? "queued");
  const normalizedStatus: AgentRunRecord["status"] =
    status === "running" || status === "completed" || status === "failed" || status === "cancelled"
      ? status
      : "queued";
  return {
    id: String(row.id ?? ""),
    updateId: Number(row.update_id ?? 0),
    chatId: Number(row.chat_id ?? 0),
    payloadJson: String(row.payload_json ?? "{}"),
    status: normalizedStatus,
    attempts: Number(row.attempts ?? 0),
    resultText: row.result_text === null || row.result_text === undefined ? null : String(row.result_text),
    errorMessage: row.error_message === null || row.error_message === undefined ? null : String(row.error_message),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : String(row.delivered_at),
  };
}

export async function insertMemoryEpisode(db: D1Database, episode: Omit<MemoryEpisodeRecord, "processedAt">): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO memory_episodes (id, chat_id, role, content, salience, created_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      )
      .bind(episode.id, episode.chatId, episode.role, episode.content, episode.salience, episode.createdAt)
      .run();
  }, 150);
}

export async function listRecentMemoryEpisodes(
  db: D1Database,
  chatId: number,
  limit: number,
): Promise<MemoryEpisodeRecord[]> {
  return retryOnce(async () => {
    const rows = await db
      .prepare(
        "SELECT id, chat_id, role, content, salience, created_at, processed_at FROM memory_episodes WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .bind(chatId, limit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapMemoryEpisodeRecord);
  }, 150);
}

export async function listUnprocessedMemoryEpisodes(
  db: D1Database,
  chatId: number,
  limit: number,
): Promise<MemoryEpisodeRecord[]> {
  return retryOnce(async () => {
    const rows = await db
      .prepare(
        "SELECT id, chat_id, role, content, salience, created_at, processed_at FROM memory_episodes WHERE chat_id = ? AND processed_at IS NULL ORDER BY created_at ASC LIMIT ?",
      )
      .bind(chatId, limit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapMemoryEpisodeRecord);
  }, 150);
}

export async function markMemoryEpisodesProcessed(
  db: D1Database,
  episodeIds: string[],
  processedAt: string,
): Promise<void> {
  if (!episodeIds.length) return;
  await retryOnce(async () => {
    for (const episodeId of episodeIds) {
      await db
        .prepare("UPDATE memory_episodes SET processed_at = ? WHERE id = ?")
        .bind(processedAt, episodeId)
        .run();
    }
  }, 150);
}

export async function createMemoryFact(
  db: D1Database,
  fact: Omit<MemoryFactRecord, "supersededBy">,
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO memory_facts (id, chat_id, kind, text, confidence, created_at, updated_at, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .bind(fact.id, fact.chatId, fact.kind, fact.text, fact.confidence, fact.createdAt, fact.updatedAt)
      .run();
  }, 150);
}

export async function upsertSimilarMemoryFact(
  db: D1Database,
  fact: Omit<MemoryFactRecord, "id" | "createdAt" | "updatedAt" | "supersededBy"> & { nowIso: string; id: string },
): Promise<{ fact: MemoryFactRecord; created: boolean }> {
  return retryOnce(async () => {
    const existing = await db
      .prepare(
        "SELECT id, chat_id, kind, text, confidence, created_at, updated_at, superseded_by FROM memory_facts WHERE chat_id = ? AND kind = ? AND superseded_by IS NULL AND lower(text) = lower(?) LIMIT 1",
      )
      .bind(fact.chatId, fact.kind, fact.text)
      .first<Record<string, unknown>>();

    if (existing) {
      const current = mapMemoryFactRecord(existing);
      const nextConfidence = Math.min(1, Math.max(current.confidence, fact.confidence));
      await db
        .prepare("UPDATE memory_facts SET confidence = ?, updated_at = ? WHERE id = ?")
        .bind(nextConfidence, fact.nowIso, current.id)
        .run();
      return {
        created: false,
        fact: {
          ...current,
          confidence: nextConfidence,
          updatedAt: fact.nowIso,
        },
      };
    }

    await createMemoryFact(db, {
      id: fact.id,
      chatId: fact.chatId,
      kind: fact.kind,
      text: fact.text,
      confidence: fact.confidence,
      createdAt: fact.nowIso,
      updatedAt: fact.nowIso,
    });

    return {
      created: true,
      fact: {
        id: fact.id,
        chatId: fact.chatId,
        kind: fact.kind,
        text: fact.text,
        confidence: fact.confidence,
        createdAt: fact.nowIso,
        updatedAt: fact.nowIso,
        supersededBy: null,
      },
    };
  }, 150);
}

export async function supersedeMemoryFact(
  db: D1Database,
  oldFactId: string,
  newFactId: string,
  updatedAt: string,
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare("UPDATE memory_facts SET superseded_by = ?, updated_at = ? WHERE id = ?")
      .bind(newFactId, updatedAt, oldFactId)
      .run();
  }, 150);
}

export async function attachMemoryFactSource(
  db: D1Database,
  factId: string,
  episodeId: string,
  createdAt: string,
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT OR IGNORE INTO memory_fact_sources (fact_id, episode_id, created_at) VALUES (?, ?, ?)",
      )
      .bind(factId, episodeId, createdAt)
      .run();
  }, 150);
}

export async function searchMemoryFactsKeyword(
  db: D1Database,
  chatId: number,
  query: string,
  limit: number,
): Promise<MemoryFactRecord[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  return retryOnce(async () => {
    const rows = await db
      .prepare(
        "SELECT f.id, f.chat_id, f.kind, f.text, f.confidence, f.created_at, f.updated_at, f.superseded_by FROM memory_facts_fts s JOIN memory_facts f ON f.id = s.fact_id WHERE s.chat_id = ? AND f.superseded_by IS NULL AND memory_facts_fts MATCH ? ORDER BY f.updated_at DESC LIMIT ?",
      )
      .bind(String(chatId), normalized, limit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapMemoryFactRecord);
  }, 150);
}

export async function listActiveMemoryFacts(db: D1Database, chatId: number, limit: number): Promise<MemoryFactRecord[]> {
  return retryOnce(async () => {
    const rows = await db
      .prepare(
        "SELECT id, chat_id, kind, text, confidence, created_at, updated_at, superseded_by FROM memory_facts WHERE chat_id = ? AND superseded_by IS NULL ORDER BY updated_at DESC LIMIT ?",
      )
      .bind(chatId, limit)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapMemoryFactRecord);
  }, 150);
}

export async function listMemoryFactsByIds(db: D1Database, chatId: number, ids: string[]): Promise<MemoryFactRecord[]> {
  if (!ids.length) return [];
  return retryOnce(async () => {
    const placeholders = ids.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT id, chat_id, kind, text, confidence, created_at, updated_at, superseded_by FROM memory_facts WHERE chat_id = ? AND id IN (${placeholders}) AND superseded_by IS NULL`,
      )
      .bind(chatId, ...ids)
      .all<Record<string, unknown>>();
    return (rows.results ?? []).map(mapMemoryFactRecord);
  }, 150);
}

export async function getActiveMemoryFactByTarget(
  db: D1Database,
  chatId: number,
  target: string,
): Promise<MemoryFactRecord | null> {
  const normalized = target.trim();
  if (!normalized) return null;
  return retryOnce(async () => {
    const row = await db
      .prepare(
        "SELECT id, chat_id, kind, text, confidence, created_at, updated_at, superseded_by FROM memory_facts WHERE chat_id = ? AND superseded_by IS NULL AND (id = ? OR lower(text) = lower(?)) LIMIT 1",
      )
      .bind(chatId, normalized, normalized)
      .first<Record<string, unknown>>();
    return row ? mapMemoryFactRecord(row) : null;
  }, 150);
}

export async function deleteMemoryFactById(db: D1Database, chatId: number, factId: string): Promise<boolean> {
  return retryOnce(async () => {
    const result = await db
      .prepare("DELETE FROM memory_facts WHERE chat_id = ? AND id = ?")
      .bind(chatId, factId)
      .run();
    return Boolean(result.meta.changes && result.meta.changes > 0);
  }, 150);
}

export async function deleteMemoryForChat(db: D1Database, chatId: number): Promise<void> {
  await retryOnce(async () => {
    await db.prepare("DELETE FROM memory_fact_sources WHERE episode_id IN (SELECT id FROM memory_episodes WHERE chat_id = ?)").bind(chatId).run();
    await db.prepare("DELETE FROM memory_episodes WHERE chat_id = ?").bind(chatId).run();
    await db.prepare("DELETE FROM memory_facts WHERE chat_id = ?").bind(chatId).run();
  }, 150);
}

export async function deleteOldMemoryEpisodes(db: D1Database, chatId: number, cutoffIso: string): Promise<void> {
  await retryOnce(async () => {
    await db.prepare("DELETE FROM memory_episodes WHERE chat_id = ? AND created_at < ?").bind(chatId, cutoffIso).run();
  }, 150);
}

function mapMemoryEpisodeRecord(row: Record<string, unknown>): MemoryEpisodeRecord {
  return {
    id: String(row.id ?? ""),
    chatId: Number(row.chat_id ?? 0),
    role: String(row.role ?? "user") as MemoryEpisodeRecord["role"],
    content: String(row.content ?? ""),
    salience: Number(row.salience ?? 0),
    createdAt: String(row.created_at ?? ""),
    processedAt: row.processed_at === null || row.processed_at === undefined ? null : String(row.processed_at),
  };
}

function mapMemoryFactRecord(row: Record<string, unknown>): MemoryFactRecord {
  return {
    id: String(row.id ?? ""),
    chatId: Number(row.chat_id ?? 0),
    kind: String(row.kind ?? "fact") as MemoryFactRecord["kind"],
    text: String(row.text ?? ""),
    confidence: Number(row.confidence ?? 0),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    supersededBy: row.superseded_by === null || row.superseded_by === undefined ? null : String(row.superseded_by),
  };
}
