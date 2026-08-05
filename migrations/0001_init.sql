-- Todo Log initial schema. See DESIGN.md for the ontology.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  timezone TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE google_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  scopes TEXT,
  updated_at INTEGER NOT NULL
);

-- Waitlist: signed-in but not enabled; "beta call" / "notify me" interest.
CREATE TABLE prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  note TEXT,
  wants_beta_call INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  -- What it is, why it matters, what "furtherance" looks like.
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'bounded' CHECK (kind IN ('bounded','ongoing')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER REFERENCES projects(id),
  title TEXT NOT NULL,
  -- What "done" looks like.
  outcome TEXT,
  -- Constraints, fears, dependencies — freeform; the agent may structure later.
  details TEXT,
  status TEXT NOT NULL DEFAULT 'idea'
    CHECK (status IN ('idea','scheduled','in_progress','done','abandoned')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- An attempt at a todo: scheduled or impromptu (todo_id nullable, linkable later).
CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  todo_id INTEGER REFERENCES todos(id),
  project_id INTEGER REFERENCES projects(id),
  title TEXT,
  scheduled_start INTEGER,
  scheduled_end INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','in_progress','done','skipped','canceled')),
  -- Projection into the dedicated "Todo Log" Google calendar.
  gcal_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Agent conversations: short-lived, started from wherever the user is in the
-- app, ended by the Done button. Durable residue lives in logs/events, not here.
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  context_type TEXT CHECK (context_type IN ('todo','action','project','log')),
  context_id INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  -- Full transcript (user) or reply (assistant). Stays NULL until every audio
  -- segment is transcribed — the cron sweep retries any message still NULL.
  text TEXT,
  created_at INTEGER NOT NULL
);

-- One row per recorded audio segment; a pause boundary closes a segment.
CREATE TABLE audio_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  seq INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  duration_sec REAL,
  transcript TEXT,
  -- Word-level timestamps: quotes in logs deep-link into audio through these.
  words_json TEXT,
  created_at INTEGER NOT NULL
);

-- The journal. A reflection is a kind of log. Paraphrase + quoted spans.
CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  message_id INTEGER REFERENCES messages(id),
  todo_id INTEGER REFERENCES todos(id),
  action_id INTEGER REFERENCES actions(id),
  project_id INTEGER REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'log' CHECK (kind IN ('log','reflection')),
  summary TEXT NOT NULL,
  -- [{text, segment_id, start, end}] — verbatim quotes with audio offsets.
  quotes_json TEXT,
  -- Observable speech features ({tags, note}), never diagnostic.
  delivery_json TEXT,
  occurred_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Audit trail of every agent-made change: renders the post-utterance change
-- feed, enables undo, and is raw material for learnings.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER REFERENCES sessions(id),
  message_id INTEGER REFERENCES messages(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('project','todo','action','log')),
  entity_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created','updated','status_changed','linked','deleted','undone')),
  -- Status changes carry the log that motivated them.
  log_id INTEGER REFERENCES logs(id),
  -- Before/after diff for display and undo.
  payload_json TEXT,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- User corrections of agent behavior, distilled out-of-band into learnings.
CREATE TABLE corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id INTEGER REFERENCES sessions(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed')),
  created_at INTEGER NOT NULL
);

-- Per-user distilled guidance ("learnings.md"), prepended to agent prompts.
CREATE TABLE learnings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_todos_user_status ON todos(user_id, status);
CREATE INDEX idx_todos_project ON todos(project_id);
CREATE INDEX idx_actions_user_sched ON actions(user_id, scheduled_start);
CREATE INDEX idx_actions_todo ON actions(todo_id);
CREATE INDEX idx_logs_user_time ON logs(user_id, occurred_at);
CREATE INDEX idx_logs_todo ON logs(todo_id);
CREATE INDEX idx_logs_action ON logs(action_id);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_segments_message ON audio_segments(message_id, seq);
CREATE INDEX idx_events_user_time ON events(user_id, created_at);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_corrections_status ON corrections(user_id, status);
