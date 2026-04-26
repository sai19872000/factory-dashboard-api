CREATE TABLE IF NOT EXISTS snapshot (
  id INTEGER PRIMARY KEY CHECK (id=1),
  payload TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
