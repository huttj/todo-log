-- Per-day dismissed ("hidden") Today-view entries, keyed by the client's
-- entry key. Server-side so the overview generator can see them and re-hide
-- regenerated equivalents.
CREATE TABLE dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dismissals_user_day_key ON dismissals(user_id, day, key);
