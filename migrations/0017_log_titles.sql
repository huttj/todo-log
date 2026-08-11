-- Short human labels for logs; the feed and cards show them over raw ids.
ALTER TABLE logs ADD COLUMN title TEXT;
