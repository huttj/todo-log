-- A log can span several utterances: the agent may fold a follow-on recording
-- into the previous log (append_to_log) instead of filing a new one. This
-- junction lists EVERY message behind a log; logs.message_id stays as the
-- first/primary message (composer gating, legacy paths).
CREATE TABLE log_messages (
  log_id INTEGER NOT NULL REFERENCES logs(id),
  message_id INTEGER NOT NULL REFERENCES messages(id),
  PRIMARY KEY (log_id, message_id)
);
CREATE INDEX idx_log_messages_message ON log_messages(message_id);

INSERT INTO log_messages (log_id, message_id)
  SELECT id, message_id FROM logs WHERE message_id IS NOT NULL;
