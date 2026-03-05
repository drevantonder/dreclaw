CREATE TABLE IF NOT EXISTS chat_inbox (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  update_id INTEGER NOT NULL UNIQUE,
  text_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_inbox_chat_consumed
  ON chat_inbox(chat_id, consumed_at, created_at);
