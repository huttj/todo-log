-- Which hat the sender wore: support replies style differently from user
-- messages even when the same person sent both (admin self-chat).
ALTER TABLE support_messages ADD COLUMN as_admin INTEGER NOT NULL DEFAULT 0;
