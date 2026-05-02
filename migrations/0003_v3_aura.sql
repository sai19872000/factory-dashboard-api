-- Migration 0003: v3 Aura surfaces
-- Additive only (IF NOT EXISTS everywhere); safe to re-apply.
--
-- Tables added:
--   memory_file          — parsed factory memory files (agents/*.md, MEMORY.md, etc.)
--   decision_entry       — one row per D-N decision register entry across all runs
--   comm_message         — 14-day sliding window of inter-agent comms
--   comm_thread          — one row per thread file (metadata only)
--   brainstorm_session   — intake brainstorm session metadata
--   brainstorm_session_chunk — session payload split into ≤512 KB chunks
--   seed_status          — tracks cold-start FTS5 backfill progress
--   search_index         — FTS5 virtual table over the full searchable corpus

-- ---------------------------------------------------------------------------
-- memory_file: canonical snapshot of every memory file the daemon has parsed.
-- path is the relative path inside ~/factory (e.g. "memory/agents/dev_lead.md").
-- parsed_json holds pre-extracted sections (ADR rows, open questions, etc.)
-- so the Worker can serve structured data without re-parsing markdown.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_file (
  path         TEXT PRIMARY KEY,   -- relative path, unique per file
  payload      TEXT NOT NULL,      -- raw markdown content
  parsed_json  TEXT,               -- pre-parsed sections JSON; null until first parse
  content_hash TEXT NOT NULL,      -- SHA-256 hex; daemon skips re-ingest on match
  updated_at   INTEGER NOT NULL    -- Unix epoch ms
);

-- ---------------------------------------------------------------------------
-- decision_entry: one row per decision register entry (D-1, D-12, …).
-- pk is "<run_id>:<decision_id>" to allow cross-run dedup and efficient lookup.
-- gate identifies the four gate decision types that require critic sign-off.
-- critic_verdict is null for non-gate decisions or when critic was not invoked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_entry (
  pk             TEXT PRIMARY KEY,   -- "<run_id>:<decision_id>", e.g. "20260501_225329:D-3"
  run_id         TEXT NOT NULL,
  decision_id    TEXT NOT NULL,      -- "D-1", "D-12", …
  gate           TEXT,               -- "adr" | "scope" | "deploy" | "pr" | null
  payload        TEXT NOT NULL,      -- full JSON (options, chosen, rationale, …)
  critic_verdict TEXT,               -- "concurring" | "dissenting" | "blocking" | null
  agent          TEXT,               -- agent that authored the decision
  updated_at     INTEGER NOT NULL    -- Unix epoch ms
);
CREATE INDEX IF NOT EXISTS idx_decision_run ON decision_entry(run_id);

-- ---------------------------------------------------------------------------
-- comm_message: file-backed inter-agent messages (flat comms + threaded).
-- filename is the basename of the comms/ file (unique per message).
-- archived=1 once read_comms.sh has moved it to comms/archive/.
-- The two indexes support the inbox view (to_agent ordered by ts) and
-- thread reconstruction (all messages in a thread ordered by ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comm_message (
  filename     TEXT PRIMARY KEY,
  from_agent   TEXT NOT NULL,
  to_agent     TEXT NOT NULL,
  subject      TEXT,
  priority     TEXT NOT NULL,        -- "p0" | "p1" | "p2"
  thread_id    TEXT,                 -- null for flat (non-threaded) comms
  payload      TEXT NOT NULL,        -- full markdown content
  ts           INTEGER NOT NULL,     -- Unix epoch ms
  archived     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comm_to_ts   ON comm_message(to_agent, ts DESC);
CREATE INDEX IF NOT EXISTS idx_comm_thread  ON comm_message(thread_id, ts ASC);

-- ---------------------------------------------------------------------------
-- comm_thread: one row per thread file in comms/threads/.
-- participants_csv is a comma-separated list of agent names for quick display.
-- last_ts and message_count are denormalized from comm_message for fast reads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comm_thread (
  thread_id      TEXT PRIMARY KEY,
  subject        TEXT,
  participants_csv TEXT NOT NULL,    -- e.g. "dev_lead,qa_lead,architect"
  status         TEXT NOT NULL,      -- "open" | "closed"
  started_at     INTEGER NOT NULL,   -- Unix epoch ms of first message
  last_ts        INTEGER NOT NULL,   -- Unix epoch ms of most recent message
  message_count  INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- brainstorm_session: metadata for each intake brainstorm session.
-- last_ts is updated on each new turn so the inbox can show recent activity.
-- outcome is set when the session concludes (ready / need-more-info / etc.).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brainstorm_session (
  session_id   TEXT PRIMARY KEY,   -- ISO timestamp or content hash
  started_at   INTEGER NOT NULL,   -- Unix epoch ms
  last_ts      INTEGER NOT NULL,   -- Unix epoch ms of last turn
  turn_count   INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT,               -- "ready" | "need-more-info" | "abandoned" | null
  total_chunks INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------------------
-- brainstorm_session_chunk: session payload split into ≤512 KB chunks.
-- Re-stitch in chunk_idx ASC order on read to recover full session markdown.
-- FK reference: session_id → brainstorm_session(session_id) — enforced in app
-- layer (D1 does not enforce FK constraints at the SQLite engine level).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brainstorm_session_chunk (
  session_id   TEXT NOT NULL,      -- → brainstorm_session.session_id
  chunk_idx    INTEGER NOT NULL,   -- 0-based; read in ASC order to re-stitch
  payload      TEXT NOT NULL,      -- markdown turns with per-turn anchors
  PRIMARY KEY (session_id, chunk_idx)
);

-- ---------------------------------------------------------------------------
-- seed_status: single-row table that tracks cold-start FTS5 backfill progress.
-- key is always "default"; status transitions: pending → running → done/failed.
-- total_docs and ingested_docs let the Worker surface a progress percentage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seed_status (
  key           TEXT PRIMARY KEY,   -- always "default"
  status        TEXT NOT NULL,      -- "pending" | "running" | "done" | "failed"
  total_docs    INTEGER NOT NULL DEFAULT 0,
  ingested_docs INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER,            -- Unix epoch ms; null until seeding begins
  ended_at      INTEGER             -- Unix epoch ms; null until seeding finishes
);

-- ---------------------------------------------------------------------------
-- search_index: FTS5 virtual table over the full searchable corpus.
-- type and ref_id are UNINDEXED (stored but not tokenized) so the Worker can
-- reconstruct deep-link routes without scanning the base tables.
-- permalink is the SPA route the hit deep-links to (UNINDEXED).
-- title and body are the indexed, searchable columns.
-- unicode61 tokenizer with diacritic-removal for accent-insensitive search.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  type      UNINDEXED,   -- "run" | "memory" | "decision" | "comm" | "thread" | "brainstorm" | "project"
  ref_id    UNINDEXED,   -- opaque ID; combined with type for dedup (e.g. run_id, path, pk)
  permalink UNINDEXED,   -- SPA route this hit deep-links to
  title,
  body,
  tokenize='unicode61 remove_diacritics 2'
);

-- Seed the seed_status singleton row so the Worker can always do
-- UPDATE ... WHERE key='default' without checking for existence first.
INSERT OR IGNORE INTO seed_status (key, status, total_docs, ingested_docs)
VALUES ('default', 'pending', 0, 0);
