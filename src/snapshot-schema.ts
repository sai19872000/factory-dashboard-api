import { z } from "zod";

// Frozen: matches Snapshot Contract v1 from architect spec exactly.
// Do NOT modify field names or types without bumping the contract version.

const AGENT_IDS = [
  "orchestrator", "intake",
  "dev_lead", "qa_lead", "biz_lead", "research_lead",
  "dev_backend", "dev_frontend", "data", "ux",
  "qa", "security",
  "prospect_researcher", "sales", "marketing", "risk", "client",
  "market_researcher", "market_watch",
  "architect", "devops", "finance", "critic",
] as const;

const AgentIdSchema = z.enum(AGENT_IDS);

const RunRefSchema = z.object({
  run_id: z.string(),
  pipeline: z.string(),
  current_task: z.string().max(80),
  started_at: z.string(),
  duration_s: z.number(),
  state: z.enum(["running", "blocked"]),
  blocker_text: z.string().max(200).nullable(),
});

const AgentStateSchema = z.object({
  id: AgentIdSchema,
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  parent: AgentIdSchema.nullable(),
  state: z.enum(["idle", "running", "blocked"]),
  current_runs: z.array(RunRefSchema),
  blocker_text: z.string().max(200).nullable(),
});

const ActivePipelineSchema = z.object({
  pipeline_name: z.string(),
  pid: z.number(),
  run_id: z.string().nullable(),
  started_at: z.string(),
  elapsed_s: z.number(),
  task_preview: z.string().max(120),
});

const AgentLaneSchema = z.object({
  // Relaxed to z.string() (Option 1b): pipeline-stage IDs like staging_audit/promote
  // are display-only in the SPA and should not be constrained to the agent roster enum.
  agent_id: z.string().min(1).max(40),
  started_at: z.string(),
  ended_at: z.string(),
  state: z.enum(["done", "failed", "skipped"]),
});

const RecentPipelineSchema = z.object({
  pipeline_name: z.string(),
  run_id: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  result: z.enum(["done", "failed", "blocked", "unknown"]),
  agent_lanes: z.array(AgentLaneSchema),
});

const CommSchema = z.object({
  filename: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  priority: z.enum(["p0", "p1", "p2"]),
  timestamp: z.string(),
  preview: z.string(),
});

const SnapshotMetaSchema = z.object({
  daemon_version: z.string(),
  parse_warnings_count: z.number(),
});

export const SnapshotV1Schema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  daemon_id: z.string(),
  factory_root: z.string(),
  agents: z.array(AgentStateSchema).length(23),
  pipelines: z.object({
    active: z.array(ActivePipelineSchema),
    recent: z.array(RecentPipelineSchema).max(10),
  }),
  recent_comms: z.array(CommSchema).max(10),
  meta: SnapshotMetaSchema,
});

export type SnapshotV1 = z.infer<typeof SnapshotV1Schema>;
