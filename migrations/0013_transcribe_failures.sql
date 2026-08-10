-- Stop retrying undecodable audio forever: count failures, give up after 5.
ALTER TABLE audio_segments ADD COLUMN transcribe_failures INTEGER NOT NULL DEFAULT 0;
