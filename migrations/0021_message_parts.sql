-- Assistant messages store their interleaved timeline (text and change-feed
-- items in true order) so replays sandwich actions between the prose that
-- preceded and followed them.
ALTER TABLE messages ADD COLUMN parts_json TEXT;
