import { retryOnce } from "../retry";

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

export async function insertMemoryEpisode(
  db: D1Database,
  episode: Omit<MemoryEpisodeRecord, "processedAt">,
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare(
        "INSERT INTO memory_episodes (id, chat_id, role, content, salience, created_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      )
      .bind(
        episode.id,
        episode.chatId,
        episode.role,
        episode.content,
        episode.salience,
        episode.createdAt,
      )
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
      .bind(
        fact.id,
        fact.chatId,
        fact.kind,
        fact.text,
        fact.confidence,
        fact.createdAt,
        fact.updatedAt,
      )
      .run();
  }, 150);
}

export async function upsertSimilarMemoryFact(
  db: D1Database,
  fact: Omit<MemoryFactRecord, "id" | "createdAt" | "updatedAt" | "supersededBy"> & {
    nowIso: string;
    id: string;
  },
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

export async function listActiveMemoryFacts(
  db: D1Database,
  chatId: number,
  limit: number,
): Promise<MemoryFactRecord[]> {
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

export async function listMemoryFactsByIds(
  db: D1Database,
  chatId: number,
  ids: string[],
): Promise<MemoryFactRecord[]> {
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

export async function deleteMemoryFactById(
  db: D1Database,
  chatId: number,
  factId: string,
): Promise<boolean> {
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
    await db
      .prepare(
        "DELETE FROM memory_fact_sources WHERE episode_id IN (SELECT id FROM memory_episodes WHERE chat_id = ?)",
      )
      .bind(chatId)
      .run();
    await db.prepare("DELETE FROM memory_episodes WHERE chat_id = ?").bind(chatId).run();
    await db.prepare("DELETE FROM memory_facts WHERE chat_id = ?").bind(chatId).run();
  }, 150);
}

export async function deleteOldMemoryEpisodes(
  db: D1Database,
  chatId: number,
  cutoffIso: string,
): Promise<void> {
  await retryOnce(async () => {
    await db
      .prepare("DELETE FROM memory_episodes WHERE chat_id = ? AND created_at < ?")
      .bind(chatId, cutoffIso)
      .run();
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
    processedAt:
      row.processed_at === null || row.processed_at === undefined ? null : String(row.processed_at),
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
    supersededBy:
      row.superseded_by === null || row.superseded_by === undefined
        ? null
        : String(row.superseded_by),
  };
}
