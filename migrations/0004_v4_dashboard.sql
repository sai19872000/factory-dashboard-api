-- Migration 0004: v4 dashboard additions
-- Additive only — IF NOT EXISTS everywhere. Safe to re-apply against a live D1 database.
-- No v3 table or column is dropped or renamed.
--
-- Additions:
--   comm_message.intake_decision     — nullable 'READY' | 'NEED_MORE_INFO' per intake-authored message
--   memory_entry                     — one row per heading-bounded section in memory files (card-grid)
--   agent_avatar                     — 23 agents, seeded at migration time for generative avatar rendering
--   run_beat                         — per-agent timing per run (Gantt + bar chart)
--   task_tree_snapshot               — write-once tasks.json blob per run

-- ---------------------------------------------------------------------------
-- 1. comm_message — add intake_decision column
-- ---------------------------------------------------------------------------
-- SQLite ALTER TABLE ADD COLUMN appends a nullable column; default NULL.
-- No backfill needed — daemon parser will populate on next ingest pass.
-- Index on (intake_decision, ts DESC) supports the "READY" / "NEED_MORE_INFO"
-- filter in GET /comms/feed.
-- ---------------------------------------------------------------------------
ALTER TABLE comm_message ADD COLUMN intake_decision TEXT;

CREATE INDEX IF NOT EXISTS idx_comm_intake_decision
  ON comm_message (intake_decision, ts DESC);

-- ---------------------------------------------------------------------------
-- 2. memory_entry — one row per heading-bounded section inside a memory file.
-- Enables the /memory/entries card-grid where each card is a discrete entry.
-- file_path mirrors memory_file.path (app-layer FK; D1 does not enforce FKs).
-- entry_id is a dash-slugified heading + zero-based ordinal within the file
--   e.g. "open-questions-0", "adr-2", "recent-wins-0".
-- type_tag vocabulary: decision | pattern | known_gap | recent_win |
--                      open_question | adr | roster | NULL (ungrouped body).
-- source_run_id is parsed from "D-N" / "run_id" back-references inside body_md;
--   null if no reference found.
-- agent_owner is inferred from the file_path (e.g. "memory/agents/dev_lead.md"
--   → "dev_lead"; "memory/MEMORY.md" → null).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_entry (
  file_path     TEXT    NOT NULL,   -- → memory_file.path
  entry_id      TEXT    NOT NULL,   -- slug + ordinal, unique within file
  type_tag      TEXT,               -- see vocabulary above
  title         TEXT    NOT NULL,   -- heading text, stripped of markdown markers
  body_md       TEXT    NOT NULL,   -- full section markdown (heading through next same-level heading)
  source_run_id TEXT,               -- nullable; run_id linked from body D-N reference
  agent_owner   TEXT,               -- agent name or null for global memory files
  last_updated  INTEGER NOT NULL,   -- Unix epoch ms; mirrors memory_file.updated_at
  PRIMARY KEY (file_path, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entry_type
  ON memory_entry (type_tag, last_updated DESC);

CREATE INDEX IF NOT EXISTS idx_memory_entry_agent
  ON memory_entry (agent_owner, type_tag);

CREATE INDEX IF NOT EXISTS idx_memory_entry_run
  ON memory_entry (source_run_id)
  WHERE source_run_id IS NOT NULL;

-- FTS5 integration: keep search_index in sync via triggers.
-- INSERT trigger adds a new FTS row for the entry.
CREATE TRIGGER IF NOT EXISTS fts_memory_entry_insert
  AFTER INSERT ON memory_entry
BEGIN
  INSERT INTO search_index (type, ref_id, permalink, title, body)
  VALUES (
    'memory',
    NEW.file_path || ':' || NEW.entry_id,
    '/memory',
    NEW.title,
    NEW.body_md
  );
END;

-- DELETE trigger removes the corresponding FTS row.
CREATE TRIGGER IF NOT EXISTS fts_memory_entry_delete
  AFTER DELETE ON memory_entry
BEGIN
  DELETE FROM search_index
  WHERE rowid IN (
    SELECT rowid FROM search_index
    WHERE ref_id = OLD.file_path || ':' || OLD.entry_id
    LIMIT 1
  );
END;

-- UPDATE trigger replaces the FTS row (delete + re-insert).
CREATE TRIGGER IF NOT EXISTS fts_memory_entry_update
  AFTER UPDATE ON memory_entry
BEGIN
  DELETE FROM search_index
  WHERE rowid IN (
    SELECT rowid FROM search_index
    WHERE ref_id = OLD.file_path || ':' || OLD.entry_id
    LIMIT 1
  );
  INSERT INTO search_index (type, ref_id, permalink, title, body)
  VALUES (
    'memory',
    NEW.file_path || ':' || NEW.entry_id,
    '/memory',
    NEW.title,
    NEW.body_md
  );
END;

-- ---------------------------------------------------------------------------
-- 3. agent_avatar — one row per agent, seeded once at migration time.
-- seed is a deterministic integer derived from the agent name:
--   seed = ascii(name[0]) * 256 + ascii(name[-1]) * 16 + length(name)
-- Frontend renders generative SVG avatars using seed as the PRNG input.
-- color_token drives the hairline ring color per Aura token vocabulary:
--   periwinkle (orchestration tier) | warm (leads + biz subs) |
--   muted (specialists + research subs) | ok (dev subs) | danger (qa + security)
-- INSERT OR IGNORE is idempotent — re-running the migration is safe.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_avatar (
  agent_name   TEXT PRIMARY KEY,
  seed         INTEGER NOT NULL,
  display_name TEXT    NOT NULL,
  role_tier    TEXT    NOT NULL,  -- 'orchestrator' | 'intake' | 'lead' | 'specialist' | 'sub'
  color_token  TEXT    NOT NULL   -- 'periwinkle' | 'warm' | 'muted' | 'ok' | 'danger'
);

INSERT OR IGNORE INTO agent_avatar (agent_name, seed, display_name, role_tier, color_token) VALUES
  ('orchestrator',        30252, 'Orchestrator',        'orchestrator', 'periwinkle'),
  ('intake',              28502, 'Intake',              'intake',       'periwinkle'),
  ('dev_lead',            27208, 'Dev Lead',            'lead',         'warm'),
  ('qa_lead',             30535, 'QA Lead',             'lead',         'warm'),
  ('biz_lead',            26696, 'Biz Lead',            'lead',         'warm'),
  ('research_lead',       30797, 'Research Lead',       'lead',         'warm'),
  ('dev_backend',         27211, 'Backend Dev',         'sub',          'ok'),
  ('dev_frontend',        27212, 'Frontend Dev',        'sub',          'ok'),
  ('data',                27156, 'Data Engineer',       'sub',          'ok'),
  ('ux',                  31874, 'UX Designer',         'sub',          'ok'),
  ('qa',                  30482, 'QA',                  'sub',          'danger'),
  ('security',            31384, 'Security',            'sub',          'danger'),
  ('prospect_researcher', 30516, 'Prospect Researcher', 'sub',          'warm'),
  ('sales',               31285, 'Sales',               'sub',          'warm'),
  ('marketing',           29561, 'Marketing',           'sub',          'warm'),
  ('risk',                30900, 'Risk',                'sub',          'warm'),
  ('client',              27206, 'Client',              'sub',          'warm'),
  ('market_researcher',   29745, 'Market Researcher',   'sub',          'muted'),
  ('market_watch',        29580, 'Market Watch',        'sub',          'muted'),
  ('architect',           26697, 'Architect',           'specialist',   'muted'),
  ('devops',              27446, 'DevOps',              'specialist',   'muted'),
  ('finance',             27735, 'Finance',             'specialist',   'muted'),
  ('critic',              26934, 'Critic',              'specialist',   'muted');

-- ---------------------------------------------------------------------------
-- 4. run_beat — per-agent timing per run.
-- One row per (run_id, agent_name); written on run-finish from state.json.
-- Supports Gantt chart (started_at → ended_at bars) and per-stage bar chart
-- (duration_s grouped by agent_name across runs).
-- status mirrors state.json vocabulary: waiting | running | done | failed | skipped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_beat (
  run_id      TEXT    NOT NULL,
  agent_name  TEXT    NOT NULL,
  started_at  INTEGER,              -- Unix epoch ms; null if agent never ran
  ended_at    INTEGER,              -- Unix epoch ms; null if still running or never ran
  duration_s  REAL,                 -- null until ended
  status      TEXT    NOT NULL,     -- 'waiting' | 'running' | 'done' | 'failed' | 'skipped'
  PRIMARY KEY (run_id, agent_name)
);

CREATE INDEX IF NOT EXISTS idx_run_beat_run
  ON run_beat (run_id);

CREATE INDEX IF NOT EXISTS idx_run_beat_agent
  ON run_beat (agent_name, started_at DESC);

-- ---------------------------------------------------------------------------
-- 5. task_tree_snapshot — write-once tasks.json blob per run.
-- Captured at run-end by the daemon (idempotent INSERT OR REPLACE).
-- Serves GET /runs/:run_id/task-tree; cached 1h on CF Worker.
-- payload is the raw tasks.json content stored as a JSON string.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_tree_snapshot (
  run_id      TEXT    PRIMARY KEY,
  payload     TEXT    NOT NULL,     -- raw tasks.json (JSON string)
  captured_at INTEGER NOT NULL      -- Unix epoch ms
);
