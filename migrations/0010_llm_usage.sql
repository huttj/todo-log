-- Per-invocation LLM usage + computed cost (from response.usage token counts).
CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- turn | briefing | checkin | distill
  model TEXT NOT NULL,
  session_id INTEGER,
  message_id INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_llm_usage_user_time ON llm_usage(user_id, created_at);
CREATE INDEX idx_llm_usage_session ON llm_usage(session_id);
