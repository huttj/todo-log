-- Schedule slots: the same todo can be scheduled (and worked) multiple times.
-- A slot is a dumb row — the todo stays the entity, logs stay the record.
-- status: planned | done | skipped (TEXT without CHECK — see 0003 for why
-- CHECKs are forever on remote D1). todos.scheduled_start/all_day are
-- deprecated in favor of slots (columns remain, unused).
CREATE TABLE todo_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  todo_id INTEGER NOT NULL REFERENCES todos(id),
  scheduled_start INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_todo_schedules_user_time ON todo_schedules(user_id, scheduled_start);

-- Existing todo schedules become slots (done todos' slots arrive done).
INSERT INTO todo_schedules (user_id, todo_id, scheduled_start, all_day, status, created_at)
SELECT user_id, id, scheduled_start, all_day,
       CASE WHEN status = 'done' THEN 'done' ELSE 'planned' END,
       updated_at
FROM todos WHERE scheduled_start IS NOT NULL;

-- One-level briefing history for undo.
ALTER TABLE briefings ADD COLUMN prev_content_json TEXT;
