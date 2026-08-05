-- Add 'paused' to project statuses. SQLite can't alter a CHECK constraint,
-- so rebuild the table in place. FK enforcement is switched off for the
-- batch: remote D1 rejects the defer_foreign_keys approach at commit when
-- children reference the dropped parent.
PRAGMA foreign_keys = OFF;

CREATE TABLE projects_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'bounded' CHECK (kind IN ('bounded','ongoing')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','completed','abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO projects_new
  SELECT id, user_id, name, description, kind, status, created_at, updated_at FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
