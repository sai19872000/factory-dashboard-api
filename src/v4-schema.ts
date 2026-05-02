// v4 endpoint response types — copy-pasteable Zod sketches + TS interfaces.
// Consumed by: dev_backend (v4-routes.ts), dev_frontend (API client types).
// Auth: all endpoints inherit CF Access JWT gating (same as v3).
// SSRF guard: path params validated against run dir before file reads.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// A. GET /pipeline/:run_id/summary
// ---------------------------------------------------------------------------
export const PipelineAgentSchema = z.object({
  name: z.string(),
  status: z.enum(['waiting', 'running', 'done', 'failed', 'skipped']),
  started_at: z.string().nullable(),   // ISO 8601
  duration_s: z.number().nullable(),
  output_path: z.string().nullable(),
  output_excerpt: z.string().max(400).nullable(),
});

export const PipelineOutputSchema = z.object({
  path: z.string(),
  agent: z.string(),
  title: z.string(),
  verdict: z.string().optional(),      // e.g. 'PASS' | 'FAIL' | 'GREEN' | 'BLOCKING'
  body_md: z.string().max(400),        // excerpt; full body via GET /outputs/:run_id/:filename
});

export const PipelineDecisionSchema = z.object({
  id: z.string(),                      // e.g. 'D-1'
  gate: z.string().nullable(),         // 'adr' | 'scope' | 'deploy' | 'pr' | null
  verdict: z.string().nullable(),      // critic_verdict or null
  title: z.string(),
});

export const TaskNodeSchema = z.object({
  id: z.string(),
  owner: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']),
  estimate_min: z.number(),
});

export const TaskEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const PipelineSummaryResponseSchema = z.object({
  run_id: z.string(),
  pipeline: z.string(),
  task: z.string(),
  started_at: z.string(),             // ISO 8601
  ended_at: z.string().nullable(),
  status: z.enum(['live', 'done', 'failed', 'blocked']),
  agents: z.array(PipelineAgentSchema),
  outputs: z.array(PipelineOutputSchema),
  decisions: z.array(PipelineDecisionSchema),
  comms_count: z.number().int().nonnegative(),
  p0_count: z.number().int().nonnegative(),
  task_tree: z.object({
    nodes: z.array(TaskNodeSchema),
    edges: z.array(TaskEdgeSchema),
  }).optional(),
});

export type PipelineSummaryResponse = z.infer<typeof PipelineSummaryResponseSchema>;

// ---------------------------------------------------------------------------
// B. GET /outputs/:run_id/:filename
// ---------------------------------------------------------------------------
export const OutputFileResponseSchema = z.object({
  run_id: z.string(),
  filename: z.string(),
  content_md: z.string().max(256 * 1024),  // 256 KB cap
});

export type OutputFileResponse = z.infer<typeof OutputFileResponseSchema>;

// ---------------------------------------------------------------------------
// C. GET /now/conveyor
// ---------------------------------------------------------------------------
export const ConveyorStageSchema = z.object({
  name: z.enum(['intake', 'architect', 'dev_lead+team', 'qa_lead+team', 'devops', 'done']),
  agents: z.array(z.string()),
});

export const ActiveRunSchema = z.object({
  run_id: z.string(),
  current_stage: z.string(),
  current_agent: z.string(),
  elapsed_s: z.number(),
  started_at: z.string(),             // ISO 8601
  task_excerpt: z.string().max(200),
});

export const FinishedRunSchema = z.object({
  run_id: z.string(),
  last_stage: z.string(),
  ended_at: z.string(),               // ISO 8601
  status: z.enum(['done', 'failed', 'blocked']),
});

export const ConveyorResponseSchema = z.object({
  stages: z.array(ConveyorStageSchema),
  active_runs: z.array(ActiveRunSchema),
  finished_today: z.array(FinishedRunSchema),
});

export type ConveyorResponse = z.infer<typeof ConveyorResponseSchema>;

// ---------------------------------------------------------------------------
// D. GET /agents/avatars
// ---------------------------------------------------------------------------
export const AgentAvatarSchema = z.object({
  agent_name: z.string(),
  seed: z.number().int(),
  display_name: z.string(),
  role_tier: z.enum(['orchestrator', 'intake', 'lead', 'specialist', 'sub']),
  color_token: z.enum(['periwinkle', 'warm', 'muted', 'ok', 'danger']),
});

export const AgentAvatarsResponseSchema = z.object({
  agents: z.array(AgentAvatarSchema),
});

export type AgentAvatarsResponse = z.infer<typeof AgentAvatarsResponseSchema>;

// ---------------------------------------------------------------------------
// E. GET /memory/entries
// Query params: type_tag?, agent_owner?, q? (FTS5), since? (ISO), cursor?
// ---------------------------------------------------------------------------
export const MemoryEntrySchema = z.object({
  file_path: z.string(),
  entry_id: z.string(),
  type_tag: z.enum(['decision', 'pattern', 'known_gap', 'recent_win', 'open_question', 'adr', 'roster']).nullable(),
  title: z.string(),
  body_md: z.string(),
  source_run_id: z.string().nullable(),
  last_updated: z.string(),           // ISO 8601
  agent_owner: z.string().nullable(),
});

export const MemoryEntriesResponseSchema = z.object({
  entries: z.array(MemoryEntrySchema),
  cursor: z.string().nullable(),       // opaque; pass as ?cursor= for next page
});

export type MemoryEntriesResponse = z.infer<typeof MemoryEntriesResponseSchema>;

// ---------------------------------------------------------------------------
// F. GET /comms/feed
// Query params: priority?, from?, to?, since? (ISO), intake_decision?, cursor?
// ---------------------------------------------------------------------------
export const CommMessageSchema = z.object({
  filename: z.string(),
  from: z.string(),
  to: z.string(),
  priority: z.enum(['p0', 'p1', 'p2']),
  channel: z.enum(['flat', 'thread', 'sub_agent_cc']),
  subject: z.string().nullable(),
  body_md: z.string(),
  ts: z.string(),                      // ISO 8601
  thread_id: z.string().optional(),
  parent_id: z.string().optional(),
  intake_decision: z.enum(['READY', 'NEED_MORE_INFO']).nullable().optional(),
});

export const CommsFeedResponseSchema = z.object({
  messages: z.array(CommMessageSchema),
  cursor: z.string().nullable(),
});

export type CommsFeedResponse = z.infer<typeof CommsFeedResponseSchema>;

// ---------------------------------------------------------------------------
// G. GET /runs/:run_id/task-tree
// ---------------------------------------------------------------------------
export const TaskTreeResponseSchema = z.object({
  run_id: z.string(),
  payload: z.unknown().nullable(),     // tasks.json parsed JSON or null if not found
  cached_at: z.string().nullable(),   // ISO 8601 of when snapshot was captured
});

export type TaskTreeResponse = z.infer<typeof TaskTreeResponseSchema>;
