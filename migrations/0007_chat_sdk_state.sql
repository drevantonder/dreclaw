CREATE TABLE IF NOT EXISTS chat_state_subscriptions (
  thread_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_state_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_state_locks (
  thread_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
