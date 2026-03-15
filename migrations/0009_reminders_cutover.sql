ALTER TABLE assistant_profile RENAME TO reminders_profile;
ALTER TABLE assistant_agenda_items RENAME TO reminders_items;
ALTER TABLE assistant_wake_runs RENAME TO reminders_wake_runs_old;

DROP INDEX IF EXISTS idx_assistant_agenda_due;
DROP INDEX IF EXISTS idx_assistant_agenda_workflow;
DROP INDEX IF EXISTS idx_assistant_wake_runs_item_started;

CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON reminders_items(status, next_wake_at, priority);

CREATE INDEX IF NOT EXISTS idx_reminders_workflow
  ON reminders_items(workflow_id, claimed_at);

CREATE TABLE reminders_wake_runs (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT,
  summary TEXT,
  error TEXT,
  next_wake_at TEXT,
  FOREIGN KEY (reminder_id) REFERENCES reminders_items(id) ON DELETE CASCADE
);

INSERT INTO reminders_wake_runs (id, reminder_id, scheduled_for, started_at, finished_at, outcome, summary, error, next_wake_at)
SELECT id, agenda_item_id, scheduled_for, started_at, finished_at, outcome, summary, error, next_wake_at
FROM reminders_wake_runs_old;

DROP TABLE reminders_wake_runs_old;

CREATE INDEX IF NOT EXISTS idx_reminders_wake_runs_item_started
  ON reminders_wake_runs(reminder_id, started_at DESC);
