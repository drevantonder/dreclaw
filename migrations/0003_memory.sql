CREATE TABLE IF NOT EXISTS memory_episodes (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  salience REAL NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_episodes_chat_created_at
  ON memory_episodes(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_episodes_chat_processed
  ON memory_episodes(chat_id, processed_at, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_by TEXT,
  FOREIGN KEY (superseded_by) REFERENCES memory_facts(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_chat_updated_at
  ON memory_facts(chat_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_facts_chat_superseded
  ON memory_facts(chat_id, superseded_by);

CREATE TABLE IF NOT EXISTS memory_fact_sources (
  fact_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (fact_id, episode_id),
  FOREIGN KEY (fact_id) REFERENCES memory_facts(id) ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES memory_episodes(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_facts_fts USING fts5(
  fact_id UNINDEXED,
  chat_id UNINDEXED,
  text
);

CREATE TRIGGER IF NOT EXISTS trg_memory_facts_fts_insert
AFTER INSERT ON memory_facts
BEGIN
  INSERT INTO memory_facts_fts(rowid, fact_id, chat_id, text)
  VALUES (new.rowid, new.id, CAST(new.chat_id AS TEXT), new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_facts_fts_update
AFTER UPDATE ON memory_facts
BEGIN
  DELETE FROM memory_facts_fts WHERE rowid = old.rowid;
  INSERT INTO memory_facts_fts(rowid, fact_id, chat_id, text)
  VALUES (new.rowid, new.id, CAST(new.chat_id AS TEXT), new.text);
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_facts_fts_delete
AFTER DELETE ON memory_facts
BEGIN
  DELETE FROM memory_facts_fts WHERE rowid = old.rowid;
END;
