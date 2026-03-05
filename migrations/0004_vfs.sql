CREATE TABLE IF NOT EXISTS vfs_entries (
  path TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vfs_entries_active_path
  ON vfs_entries(deleted_at, path);

CREATE TABLE IF NOT EXISTS vfs_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO vfs_meta (id, revision, updated_at)
VALUES (1, 0, '1970-01-01T00:00:00.000Z');
