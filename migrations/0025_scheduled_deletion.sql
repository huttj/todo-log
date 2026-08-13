-- Account deletion is scheduled, not instant: delete_after is the epoch when
-- the cron purge may destroy everything. Signing back in clears it.
ALTER TABLE users ADD COLUMN delete_after INTEGER;
