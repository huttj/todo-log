-- Per-user agent tuning: {"model": "sonnet"|"haiku", "thinking": bool}
ALTER TABLE users ADD COLUMN agent_config TEXT;
