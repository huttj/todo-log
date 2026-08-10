-- ask_user tool: the agent can interrupt with questions + suggested answers,
-- rendered as tappable chips. Stored on the assistant message for replay.
ALTER TABLE messages ADD COLUMN questions_json TEXT;
