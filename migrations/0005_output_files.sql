-- Migration 0005: output_file storage for GET /outputs/:run_id/:filename
-- Additive only — IF NOT EXISTS. Safe to re-apply.
--
-- Additions:
--   output_file — stores raw markdown content of factory output files
--                 pushed by the daemon; served by GET /outputs/:run_id/:filename

CREATE TABLE IF NOT EXISTS output_file (
  run_id     TEXT    NOT NULL,   -- e.g. '20260502_171745'
  filename   TEXT    NOT NULL,   -- e.g. 'dev_backend_v4_20260502_171746.md'
  content_md TEXT    NOT NULL,   -- raw markdown, daemon enforces ≤256 KB
  updated_at INTEGER NOT NULL,   -- Unix epoch ms
  PRIMARY KEY (run_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_output_file_run
  ON output_file (run_id);
