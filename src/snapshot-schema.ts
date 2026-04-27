import { z } from "zod";

// Snapshot Contract — v1 (frozen) + v2 (additive).
// Worker accepts both; daemon stamps version: 1 or version: 2.
// SPA must tolerate both during the daemon-rollback window (§10).

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

// v2 additions: pipeline_type + current_station_id + pipeline_detail_hash + agent_lanes (optional for v1 compat)
const PipelineTypeSchema = z.enum([
  "build", "product", "research", "outbound", "morning", "unknown",
]);

const AgentLaneSchema = z.object({
  // Relaxed to z.string() (Option 1b): pipeline-stage IDs like staging_audit/promote
  // are display-only in the SPA and should not be constrained to the agent roster enum.
  agent_id: z.string().min(1).max(40),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  state: z.enum(["done", "failed", "skipped", "running"]),
});

const ActivePipelineSchema = z.object({
  pipeline_name: z.string(),
  // v2 fields — optional so v1 payloads remain valid
  pipeline_type: PipelineTypeSchema.optional(),
  pid: z.number(),
  run_id: z.string().nullable(),
  started_at: z.string(),
  elapsed_s: z.number(),
  task_preview: z.string().max(120),
  current_station_id: z.string().nullable().optional(),
  pipeline_detail_hash: z.string().optional(),
  agent_lanes: z.array(AgentLaneSchema).optional(),
});

const RecentPipelineSchema = z.object({
  pipeline_name: z.string(),
  // v2 fields — optional so v1 payloads remain valid
  pipeline_type: PipelineTypeSchema.optional(),
  run_id: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  result: z.enum(["done", "failed", "blocked", "unknown"]),
  agent_lanes: z.array(AgentLaneSchema),
  pipeline_detail_hash: z.string().optional(),
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

// Unified schema: accepts version 1 (v1 daemon) or 2 (v2 daemon).
// recent cap raised to 50 (was 10) for Conveyor "show older" reveal.
export const SnapshotV1Schema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  generated_at: z.string(),
  daemon_id: z.string(),
  factory_root: z.string(),
  agents: z.array(AgentStateSchema).length(23),
  pipelines: z.object({
    active: z.array(ActivePipelineSchema),
    recent: z.array(RecentPipelineSchema).max(50),
  }),
  recent_comms: z.array(CommSchema).max(10),
  meta: SnapshotMetaSchema,
});

export type SnapshotV1 = z.infer<typeof SnapshotV1Schema>;

// ---------------------------------------------------------------------------
// Surface B — Agent profiles ingest schema (POST /ingest/profiles body)
// ---------------------------------------------------------------------------

export const AgentProfilesIngestSchema = z.object({
  agents: z.record(
    z.string(),
    z.object({
      role: z.string().max(240),
      function_blurb: z.string().max(1536), // ≤1.5 KB
      frontmatter: z.record(z.string(), z.unknown()),
      memory_md: z.string().nullable(),
    })
  ),
});

export type AgentProfilesIngest = z.infer<typeof AgentProfilesIngestSchema>;

// ---------------------------------------------------------------------------
// Surface C — Pipeline detail ingest schema (POST /ingest/pipeline/:run_id body)
// Shape matches §4.4 PipelineDetail interface.
// ---------------------------------------------------------------------------

export const PipelineDetailIngestSchema = z.object({
  run_id: z.string(),
  pipeline_type: z.enum(["build", "product", "research", "outbound", "morning"]),
  status: z.enum(["live", "done", "failed", "blocked"]),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  beats: z.array(
    z.object({
      agent_id: z.string(),
      started_at: z.string(),
      // null when state === "running" — daemon emits null for in-flight beats
      // so pipeline_detail content_hash stays stable across ticks (otherwise
      // ended_at=now() on every tick would force a re-push). Spec §4.4 typed
      // this as string only; widened here in lockstep with SPA + amended spec.
      ended_at: z.string().nullable(),
      state: z.enum(["done", "failed", "skipped", "running"]),
      output_file: z.string().nullable(),
    })
  ),
  comms: z.array(
    z.object({
      filename: z.string(),
      from: z.string(),
      to: z.string(),
      subject: z.string(),
      preview: z.string().max(140),
      timestamp: z.string(),
      from_run_id: z.string().optional(),
    })
  ),
});

export type PipelineDetailIngest = z.infer<typeof PipelineDetailIngestSchema>;
