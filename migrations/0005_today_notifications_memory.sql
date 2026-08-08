-- Day-level scheduling, planning sessions, agent-controlled notifications,
-- agent memory, and the periodic check-in timer. All additive (see 0003 for
-- why rebuilds are off the table on remote D1).

-- All-day actions: scheduled_start holds local midnight of the day.
ALTER TABLE actions ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;

-- 'plan' sessions get the day-planning prompt addendum.
ALTER TABLE sessions ADD COLUMN mode TEXT;

-- Check-in cadence marker (updated on every attempt, including skips).
ALTER TABLE users ADD COLUMN last_checkin_at INTEGER;

-- One living notification per (user, slot) — the agent rewrites in place
-- rather than stacking. Slots: 'checkin' for the periodic wake; the agent can
-- invent others.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slot TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, slot)
);

-- Agent long-term memory: keyed notes, overwritten in place.
CREATE TABLE agent_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, key)
);
