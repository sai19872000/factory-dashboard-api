import { z } from "zod";

// ---------------------------------------------------------------------------
// v3 Ingest schemas — four new POST /ingest/* routes
// ---------------------------------------------------------------------------

// POST /ingest/memory — { MEMORY_md, agents: { [name]: { content, mtime } } }
export const IngestMemorySchema = z.object({
  MEMORY_md: z.string().max(512 * 1024), // 512 KB guard (body limit matches in v3-routes.ts)
  agents: z.record(
    z.string(),
    z.object({
      content: z.string(),
      mtime: z.number(), // Unix epoch ms
      content_hash: z.string().nullable().optional(),
      parsed_json: z.string().nullable().optional(),
    })
  ).optional(),
});
export type IngestMemory = z.infer<typeof IngestMemorySchema>;

// POST /ingest/decisions — one POST per run
export const DecisionEntrySchema = z.object({
  decision_id: z.string().max(20),      // "D-1", "D-12"
  title: z.string().max(200),
  gate: z.enum(["adr", "scope", "deploy", "pr"]).nullable().optional(),
  options: z.array(z.string().max(400)).max(10).nullable().optional(),
  chosen: z.string().max(400).nullable().optional(),
  rationale: z.string().nullable().optional(),
  self_critique: z.string().nullable().optional(),
  critic_verdict: z.enum(["concurring", "dissenting", "blocking"]).nullable().optional(),
  critic_path: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  parsed: z.boolean().optional(),
  payload: z.string().nullable().optional(), // raw markdown fallback when parsed=false
});

export const IngestDecisionsSchema = z.object({
  run_id: z.string(),
  decisions: z.array(DecisionEntrySchema).max(100),
});
export type IngestDecisions = z.infer<typeof IngestDecisionsSchema>;

// POST /ingest/comms — 14-day sliding window
export const CommMessageSchema = z.object({
  filename: z.string().max(200),
  from_agent: z.string().max(80),
  to_agent: z.string().max(80),
  subject: z.string().max(400).nullable().optional(),
  priority: z.enum(["p0", "p1", "p2"]),
  thread_id: z.string().nullable().optional(),
  payload: z.string(),
  ts: z.number(),
  archived: z.number().default(0),
});

export const CommThreadSchema = z.object({
  thread_id: z.string().max(200),
  subject: z.string().max(400).nullable().optional(),
  participants_csv: z.string().max(500),
  status: z.enum(["open", "closed"]),
  started_at: z.number(),
  last_ts: z.number(),
  message_count: z.number(),
});

export const IngestCommsSchema = z.object({
  messages: z.array(CommMessageSchema).max(500),
  threads: z.array(CommThreadSchema).max(200),
});
export type IngestComms = z.infer<typeof IngestCommsSchema>;

// POST /ingest/brainstorms — chunked session payload
export const BrainstormTurnSchema = z.object({
  idx: z.number(),
  who: z.string().max(80),
  ts: z.string().max(40),
  content: z.string().max(16 * 1024), // 16 KB per-turn truncation
});

export const IngestBrainstormsSchema = z.object({
  session_id: z.string().max(200),
  chunk_idx: z.number().min(0),
  total_chunks: z.number().min(1),
  started_at: z.number().optional(),
  last_ts: z.number().optional(),
  ended_at: z.number().nullable().optional(),
  outcome: z.enum(["ready", "need-more-info", "abandoned"]).nullable().optional(),
  turns: z.array(BrainstormTurnSchema).max(1000),
});
export type IngestBrainstorms = z.infer<typeof IngestBrainstormsSchema>;

// ---------------------------------------------------------------------------
// v3 Query schemas — GET routes with query params
// ---------------------------------------------------------------------------

export const SearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  types: z.string().optional(), // csv: "runs,decisions,memory,comms,brainstorms,projects"
  limit: z.coerce.number().min(1).max(20).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

// Valid search types
export const SEARCH_TYPES = ["runs", "memory", "decision", "comm", "thread", "brainstorm", "project"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

// ---------------------------------------------------------------------------
// v3 Response shapes (for documentation; Worker builds these directly)
// ---------------------------------------------------------------------------

// /runs list item
export interface RunListItem {
  run_id: string;
  pipeline: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  task: string;
}

// /memory list item
export interface MemoryFileItem {
  path: string;
  content_hash: string;
  updated_at: number;
  parsed_json: string | null;
}

// /decisions list item
export interface DecisionListItem {
  pk: string;
  run_id: string;
  decision_id: string;
  gate: string | null;
  agent: string | null;
  title: string | null;
  critic_verdict: string | null;
  updated_at: number;
}

// /comms list item
export interface CommListItem {
  filename: string;
  from_agent: string;
  to_agent: string;
  subject: string | null;
  priority: string;
  thread_id: string | null;
  ts: number;
  archived: number;
}

// /search hit
export interface SearchHit {
  type: string;
  ref_id: string;
  permalink: string;
  title: string;
  snippet: string;
  rank: number;
}
