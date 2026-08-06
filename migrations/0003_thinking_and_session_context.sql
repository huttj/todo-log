-- Replay parity + chats as capture context, additive-only.
-- (Widening sessions.context_type's CHECK to include 'session' would need a
-- table rebuild, and remote D1 can't drop a populated referenced table:
-- PRAGMA foreign_keys is ignored and defer_foreign_keys still fails at
-- commit. So "talk about a chat" gets its own nullable column instead.)

-- Persist the agent's thinking alongside each assistant reply.
ALTER TABLE messages ADD COLUMN thinking TEXT;

-- Set when a session's context is a past chat ("talk about this conversation").
ALTER TABLE sessions ADD COLUMN about_session_id INTEGER;
