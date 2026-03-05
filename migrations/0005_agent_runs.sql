CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  update_id INTEGER NOT NULL UNIQUE,
  chat_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_text TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated
  ON agent_runs(status, updated_at);
