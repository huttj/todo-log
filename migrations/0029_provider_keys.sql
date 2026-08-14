-- BYOK: one API key per provider per user, AES-GCM encrypted at rest
-- (wrapping secret from the worker env — never stored). tail = last 4 chars
-- for masked display. llm_usage gains the provider dimension so spend can be
-- attributed to the user's own key (byok=1) vs the house Anthropic key.
CREATE TABLE provider_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tail TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, provider)
);
ALTER TABLE llm_usage ADD COLUMN provider TEXT;
ALTER TABLE llm_usage ADD COLUMN byok INTEGER NOT NULL DEFAULT 0;
