-- Migration 0008: v5 Memory Section — skills, playbooks, project memories.
-- Additive only (IF NOT EXISTS). No existing table is dropped or renamed.

-- ---------------------------------------------------------------------------
-- 1. skill_file — ~/factory/.claude/skills/<name>/SKILL.md
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_file (
  name           TEXT PRIMARY KEY,    -- e.g. "factory-comms"
  description    TEXT,                -- from frontmatter; nullable
  payload        TEXT NOT NULL,       -- raw markdown
  parsed_json    TEXT,                -- JSON string: { name, description, when_to_use, ... }
  content_hash   TEXT NOT NULL,
  updated_at     INTEGER NOT NULL     -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_skill_updated ON skill_file(updated_at DESC);

-- ---------------------------------------------------------------------------
-- 2. playbook_file — per-agent at memory/playbooks/<owner>/<slug>.md
--                    per-project at memory/projects/<slug>/playbooks/<pb_slug>.md
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS playbook_file (
  pk             TEXT PRIMARY KEY,    -- "<scope>:<owner>:<slug>"
  scope          TEXT NOT NULL,       -- "agent" | "project"
  owner          TEXT NOT NULL,       -- agent name or project slug
  slug           TEXT NOT NULL,
  description    TEXT,
  payload        TEXT NOT NULL,
  parsed_json    TEXT,                -- JSON: { name, description, use_count?, last_used? }
  content_hash   TEXT NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pb_scope_owner ON playbook_file(scope, owner, slug);
CREATE INDEX IF NOT EXISTS idx_pb_updated ON playbook_file(updated_at DESC);

-- ---------------------------------------------------------------------------
-- 3. project_memory_file — memory/projects/<slug>.md + registry meta + staleness
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_memory_file (
  slug              TEXT PRIMARY KEY,
  status            TEXT,                  -- registry status: active | dormant | planned | closed
  repo              TEXT,
  local_clone       TEXT,
  deploy_url        TEXT,
  payload           TEXT NOT NULL,         -- raw markdown of memory/projects/<slug>.md
  parsed_json       TEXT,                  -- structured: { current_state, recent_decisions, ... }
  staleness         TEXT,                  -- fresh | drifting | stale | dormant
  staleness_days    INTEGER,
  recent_runs_json  TEXT,                  -- JSON array of {run_id, ts, pipeline, lead, outcome}
  recent_comms_json TEXT,                  -- JSON array of {filename, ts, from, to, thread_id}
  recent_outputs_json TEXT,               -- JSON array of {path, agent, run_id, ts}
  content_hash      TEXT NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_status ON project_memory_file(status);
CREATE INDEX IF NOT EXISTS idx_pm_staleness ON project_memory_file(staleness);
CREATE INDEX IF NOT EXISTS idx_pm_updated ON project_memory_file(updated_at DESC);
