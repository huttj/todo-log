-- The ontology collapse: todos absorb scheduling (user decision 2026-08-10 —
-- todos and actions duplicated each other). Actions retire; logs are the
-- record of what happened. Additive only; the actions table stays but is
-- emptied by the one-off conversion run alongside this migration.
ALTER TABLE todos ADD COLUMN scheduled_start INTEGER;
ALTER TABLE todos ADD COLUMN all_day INTEGER NOT NULL DEFAULT 0;
