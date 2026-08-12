-- Human support chat: one thread per user; senders are the user or an admin.
-- Voice notes keep their audio in R2 alongside the transcript. No AI here.
CREATE TABLE support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  r2_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_support_thread ON support_messages(user_id, id);
