CREATE TABLE IF NOT EXISTS google_oauth_states (
  state TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_google_oauth_states_expires_at ON google_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS google_oauth_tokens (
  principal TEXT PRIMARY KEY,
  telegram_user_id INTEGER,
  refresh_token_ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  scopes TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
