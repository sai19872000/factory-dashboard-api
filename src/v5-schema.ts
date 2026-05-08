import { z } from "zod";

// ---------------------------------------------------------------------------
// v5 Ingest schemas
// ---------------------------------------------------------------------------

// POST /ingest/skills — { skills: { [name]: { content, mtime, frontmatter? } } }
const SkillEntrySchema = z.object({
  content:    z.string(),
  mtime:      z.number(), // Unix epoch ms
  frontmatter: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const IngestSkillsSchema = z.object({
  skills: z.record(z.string(), SkillEntrySchema),
});
export type IngestSkills = z.infer<typeof IngestSkillsSchema>;

// POST /ingest/playbooks — { playbooks: [...] }
const PlaybookEntrySchema = z.object({
  scope:       z.enum(["agent", "project"]),
  owner:       z.string().min(1).max(200),
  slug:        z.string().min(1).max(200),
  content:     z.string(),
  mtime:       z.number(),
  frontmatter: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const IngestPlaybooksSchema = z.object({
  playbooks: z.array(PlaybookEntrySchema).max(100),
});
export type IngestPlaybooks = z.infer<typeof IngestPlaybooksSchema>;

// POST /ingest/project-memories — { projects: [...] }
const RunRefSchema = z.object({
  run_id:   z.string(),
  ts:       z.number(),
  pipeline: z.string().nullable().optional(),
  lead:     z.string().nullable().optional(),
  outcome:  z.string().nullable().optional(),
});

const CommRefSchema = z.object({
  filename:  z.string(),
  ts:        z.number(),
  from:      z.string().nullable().optional(),
  to:        z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
});

const OutputRefSchema = z.object({
  path:   z.string(),
  agent:  z.string().nullable().optional(),
  run_id: z.string().nullable().optional(),
  ts:     z.number(),
});

const RegistryMetaSchema = z.object({
  status:      z.string().nullable().optional(),
  repo:        z.string().nullable().optional(),
  local_clone: z.string().nullable().optional(),
  deploy_url:  z.string().nullable().optional(),
}).nullable().optional();

const StalenessSchema = z.object({
  verdict: z.enum(["fresh", "drifting", "stale", "dormant"]),
  days:    z.number().int().nonnegative(),
}).nullable().optional();

const ProjectMemoryEntrySchema = z.object({
  slug:            z.string().min(1).max(200),
  content:         z.string(),
  mtime:           z.number(),
  registry:        RegistryMetaSchema,
  staleness:       StalenessSchema,
  recent_runs:     z.array(RunRefSchema).max(50).nullable().optional(),
  recent_comms:    z.array(CommRefSchema).max(100).nullable().optional(),
  recent_outputs:  z.array(OutputRefSchema).max(100).nullable().optional(),
});

export const IngestProjectMemoriesSchema = z.object({
  projects: z.array(ProjectMemoryEntrySchema).max(50),
});
export type IngestProjectMemories = z.infer<typeof IngestProjectMemoriesSchema>;

// ---------------------------------------------------------------------------
// v5 Query schemas
// ---------------------------------------------------------------------------

export const PlaybooksQuerySchema = z.object({
  scope: z.enum(["agent", "project"]).optional(),
  owner: z.string().max(200).optional(),
  q:     z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(200).default(100),
});
export type PlaybooksQuery = z.infer<typeof PlaybooksQuerySchema>;

export const ProjectMemoriesQuerySchema = z.object({
  status:    z.string().max(50).optional(),
  staleness: z.enum(["fresh", "drifting", "stale", "dormant"]).optional(),
});
export type ProjectMemoriesQuery = z.infer<typeof ProjectMemoriesQuerySchema>;

// ---------------------------------------------------------------------------
// v5 Response interfaces (documentation; routes build these directly)
// ---------------------------------------------------------------------------

export interface SkillListItem {
  name:         string;
  description:  string | null;
  content_hash: string;
  updated_at:   number;
}

export interface SkillDetail {
  name:         string;
  description:  string | null;
  content:      string;
  parsed_json:  string | null;
  updated_at:   number;
}

export interface PlaybookListItem {
  pk:           string;
  scope:        string;
  owner:        string;
  slug:         string;
  description:  string | null;
  content_hash: string;
  updated_at:   number;
}

export interface PlaybookDetail {
  pk:          string;
  scope:       string;
  owner:       string;
  slug:        string;
  description: string | null;
  content:     string;
  parsed_json: string | null;
  updated_at:  number;
}

export interface ProjectMemoryListItem {
  slug:               string;
  status:             string | null;
  deploy_url:         string | null;
  staleness:          string | null;
  staleness_days:     number | null;
  updated_at:         number;
  recent_runs_count:  number;
  recent_comms_count: number;
}

export interface ProjectMemoryDetail {
  slug:              string;
  status:            string | null;
  repo:              string | null;
  local_clone:       string | null;
  deploy_url:        string | null;
  content:           string;
  parsed_json:       string | null;
  staleness:         string | null;
  staleness_days:    number | null;
  recent_runs:       unknown[];
  recent_comms:      unknown[];
  recent_outputs:    unknown[];
  updated_at:        number;
}
