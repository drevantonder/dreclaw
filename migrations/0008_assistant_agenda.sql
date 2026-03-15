CREATE TABLE IF NOT EXISTS assistant_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL,
  primary_chat_id INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_agenda_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL,
  schedule_json TEXT,
  next_wake_at TEXT,
  last_wake_at TEXT,
  snooze_until TEXT,
  source_chat_id INTEGER,
  claimed_at TEXT,
  claim_token TEXT,
  workflow_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_agenda_due
  ON assistant_agenda_items(status, next_wake_at, priority);

CREATE INDEX IF NOT EXISTS idx_assistant_agenda_workflow
  ON assistant_agenda_items(workflow_id, claimed_at);

CREATE TABLE IF NOT EXISTS assistant_wake_runs (
  id TEXT PRIMARY KEY,
  agenda_item_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  summary TEXT,
  error TEXT,
  next_wake_at TEXT,
  FOREIGN KEY (agenda_item_id) REFERENCES assistant_agenda_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assistant_wake_runs_item_started
  ON assistant_wake_runs(agenda_item_id, started_at DESC);
