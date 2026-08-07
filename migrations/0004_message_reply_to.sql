-- Pair each assistant reply with the user message it answers. Message ids
-- alone don't give conversation order: a user message row is created when
-- recording STARTS, so with queued fire-and-forget sends the next utterance's
-- row can predate the previous turn's reply.
ALTER TABLE messages ADD COLUMN reply_to INTEGER;
