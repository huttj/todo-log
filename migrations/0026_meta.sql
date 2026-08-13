-- Tiny key/value for operational markers (e.g. embedding sync watermark).
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
