import { retryOnce } from "../../utils/retry";

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

export async function getVfsRevision(db: D1Database): Promise<number> {
  return retryOnce(async () => {
    const row = await db
      .prepare("SELECT revision FROM vfs_meta WHERE id = 1")
      .first<Record<string, unknown>>();
    if (row && row.revision !== null && row.revision !== undefined) return Number(row.revision);
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
    if (existing && !input.overwrite) return { ok: false as const, code: "EEXIST" as const };
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
    await bumpVfsRevision(db, input.nowIso);
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
    if (deleted) await bumpVfsRevision(db, nowIso);
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
    if (changes > 0) await bumpVfsRevision(db, nowIso);
    return changes;
  }, 150);
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

function toStringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return fallback;
}
