-- "Talk about this" seeding: a session can open pre-loaded with a piece of
-- briefing text (e.g. a loose thread) as its context.
ALTER TABLE sessions ADD COLUMN seed_text TEXT;
