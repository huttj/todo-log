-- Cost of the generation that produced the current briefing (null when the
-- agent rewrote it in-turn — that cost belongs to the chat turn).
ALTER TABLE briefings ADD COLUMN cost_usd REAL;
