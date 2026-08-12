-- Word timings for support voice notes, so the shared transcript player
-- (tap-a-word playback, highlighting) works there too.
ALTER TABLE support_messages ADD COLUMN words_json TEXT;
