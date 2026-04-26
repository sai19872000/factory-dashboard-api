-- Migration 0002: v2 surfaces — agent_profile + pipeline_detail
-- Additive only; existing snapshot table is untouched.

CREATE TABLE IF NOT EXISTS agent_profile (
  agent_id     TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,        -- JSON: { role, function_blurb, frontmatter, memory_md }
  content_hash TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_detail (
  run_id        TEXT PRIMARY KEY,
  pipeline_type TEXT NOT NULL,        -- 'build' | 'product' | 'research' | 'outbound' | 'morning'
  status        TEXT NOT NULL,        -- 'live' | 'done' | 'failed' | 'blocked'
  payload       TEXT NOT NULL,        -- JSON: PipelineDetail shape (§4.4)
  content_hash  TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_detail_recent
  ON pipeline_detail (updated_at DESC);
