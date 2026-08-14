-- Logs are free-form: one utterance can touch any number of projects and
-- todos. These junctions are the source of truth for log attachments.
-- logs.project_id / logs.todo_id are DEPRECATED after this migration: seeded
-- here, then never read or written again (kept only to avoid a risky column
-- drop on a live table).
CREATE TABLE log_projects (
  log_id INTEGER NOT NULL REFERENCES logs(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  PRIMARY KEY (log_id, project_id)
);
CREATE INDEX idx_log_projects_project ON log_projects(project_id);

CREATE TABLE log_todos (
  log_id INTEGER NOT NULL REFERENCES logs(id),
  todo_id INTEGER NOT NULL REFERENCES todos(id),
  PRIMARY KEY (log_id, todo_id)
);
CREATE INDEX idx_log_todos_todo ON log_todos(todo_id);

INSERT INTO log_projects (log_id, project_id)
  SELECT id, project_id FROM logs WHERE project_id IS NOT NULL;
INSERT INTO log_todos (log_id, todo_id)
  SELECT id, todo_id FROM logs WHERE todo_id IS NOT NULL;
