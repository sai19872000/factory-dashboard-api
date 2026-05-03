-- Migration 0006: add parent_id column to comm_message
-- Fixes: GET /comms/feed returned 500 because SELECT referenced parent_id
--        which was in the TypeScript CommMessageRow interface and handler
--        SELECT clause but was never added to the table schema.
--
-- Safe to re-apply: ALTER TABLE ADD COLUMN is idempotent on D1
-- when wrapped in a try/catch at application level; the column will simply
-- already exist on a second run and SQLite will error, which is fine.
-- All existing rows get NULL (column is nullable; no backfill needed).
--
-- The daemon does not yet emit parent_id in /ingest/comms payloads —
-- that is a future enhancement for thread-reply tracking. For now the
-- column sits at NULL and the GET handler already skips null parent_ids
-- (  if (row.parent_id) msg.parent_id = row.parent_id  ).

ALTER TABLE comm_message ADD COLUMN parent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_comm_parent_id
  ON comm_message (parent_id)
  WHERE parent_id IS NOT NULL;
