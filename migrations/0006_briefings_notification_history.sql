-- Precomputed daily briefing + notification history + reply-to linkage.
-- All additive (remote D1 can't rebuild referenced tables — see 0003).

-- Dismissing a notification keeps it (chats can reference history).
ALTER TABLE notifications ADD COLUMN dismissed_at INTEGER;

-- Session started from a notification's reply button.
ALTER TABLE sessions ADD COLUMN re_notification_id INTEGER;

-- One living briefing per user, regenerated after chats and by cron.
CREATE TABLE briefings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  content_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
