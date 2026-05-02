/**
 * v4 Dashboard route handlers — additive on top of v3.
 *
 * READ endpoints (CF Access JWT-gated, ACAO wrapped by index.ts):
 *   GET /pipeline/:run_id/summary   — rich pipeline build summary (A)
 *   GET /outputs/:run_id/:filename  — raw output markdown, SSRF-validated, 5-min cache (B)
 *   GET /now/conveyor               — factory conveyor stage view (C)
 *   GET /agents/avatars             — 23 agent avatar rows (D)
 *   GET /memory/entries             — paginated memory cards, FTS5 when q= present (E)
 *   GET /comms/feed                 — descriptive comms feed with filters (F)
 *   GET /runs/:run_id/task-tree     — task tree snapshot, 1h cache (G)
 *
 * INGEST endpoints (bearer auth, body-size capped):
 *   POST /ingest/v4/intake-decisions  — update comm_message.intake_decision
 *   POST /ingest/v4/memory-entries    — upsert memory_entry rows + orphan delete
 *   POST /ingest/v4/run-beats         — upsert run_beat rows
 *   POST /ingest/v4/task-tree/:run_id — upsert task_tree_snapshot
 *   POST /ingest/v4/outputs/:run_id   — bulk upsert output file content
 */

import { validateBearer } from "./auth-bearer";
import { validateCfAccessJwt } from "./auth-cf-access";
import {
  PipelineSummaryResponseSchema,
  OutputFileResponseSchema,
  ConveyorResponseSchema,
  AgentAvatarsResponseSchema,
  MemoryEntriesResponseSchema,
  CommsFeedResponseSchema,
  TaskTreeResponseSchema,
} from "./v4-schema";

// ---------------------------------------------------------------------------
// Env (matches index.ts Env — reused to avoid circular import)
// ---------------------------------------------------------------------------

export interface V4Env {
  DASHBOARD_DB: D1Database;
  INGEST_TOKEN: string;
  CF_ACCESS_AUD_SNAPSHOT: string;
  CF_ACCESS_TEAM_DOMAIN: string;
}

// ---------------------------------------------------------------------------
// Conveyor stage config
// ---------------------------------------------------------------------------

const CONVEYOR_STAGES = [
  { name: "intake" as const,        agents: ["intake"] },
  { name: "architect" as const,     agents: ["architect"] },
  { name: "dev_lead+team" as const, agents: ["dev_lead", "dev_backend", "dev_frontend", "data", "ux"] },
  { name: "qa_lead+team" as const,  agents: ["qa_lead", "qa", "security"] },
  { name: "devops" as const,        agents: ["devops"] },
  { name: "done" as const,          agents: [] },
] as const;

const AGENT_TO_STAGE: Record<string, string> = {
  intake:       "intake",
  architect:    "architect",
  dev_lead:     "dev_lead+team",
  dev_backend:  "dev_lead+team",
  dev_frontend: "dev_lead+team",
  data:         "dev_lead+team",
  ux:           "dev_lead+team",
  qa_lead:      "qa_lead+team",
  qa:           "qa_lead+team",
  security:     "qa_lead+team",
  devops:       "devops",
};

// ---------------------------------------------------------------------------
// SSRF validation — run_id and filename path params
// ---------------------------------------------------------------------------

const RUN_ID_RE   = /^[0-9]{8}_[0-9]{6}$/;
const FILENAME_RE = /^[a-zA-Z0-9_\-\.]+\.md$/;

function validateRunId(run_id: string): boolean {
  return RUN_ID_RE.test(run_id);
}

function validateFilename(filename: string): boolean {
  return (
    FILENAME_RE.test(filename) &&
    !filename.includes("..") &&
    !filename.includes("/") &&
    !filename.includes("\\")
  );
}

// ---------------------------------------------------------------------------
// Body size limits for ingest routes
// ---------------------------------------------------------------------------

const LIMIT_INTAKE_DECISIONS = 64  * 1024;   //  64 KB — small update batches
const LIMIT_MEMORY_ENTRIES   = 256 * 1024;   // 256 KB — memory file sections
const LIMIT_RUN_BEATS        = 64  * 1024;   //  64 KB — beat rows
const LIMIT_TASK_TREE        = 64  * 1024;   //  64 KB — tasks.json
const LIMIT_OUTPUT_FILES     = 512 * 1024;   // 512 KB — bulk output bundle

const ALLOWED_EMAIL = "sai19872000@gmail.com";

// ---------------------------------------------------------------------------
// Local helpers (intentionally duplicated from index.ts to avoid circular dep)
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function requireCfAccess(request: Request, env: V4Env): Promise<Response | null> {
  const result = await validateCfAccessJwt(
    request,
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD_SNAPSHOT,
    ALLOWED_EMAIL
  );
  if (!result.ok) return new Response(null, { status: result.status });
  return null;
}

async function requireBearer(request: Request, env: V4Env): Promise<Response | null> {
  const r = validateBearer(request, env.INGEST_TOKEN);
  if (!r.ok) return new Response(null, { status: 401 });
  return null;
}

async function readBodyCapped(
  request: Request,
  limitBytes: number,
  label: string
): Promise<{ ok: true; rawBody: string } | { ok: false; response: Response }> {
  const cl = request.headers.get("Content-Length");
  if (cl !== null && parseInt(cl, 10) > limitBytes) {
    return { ok: false, response: json({ error: `body exceeds ${label}` }, 413) };
  }
  let buf: ArrayBuffer;
  try {
    buf = await request.arrayBuffer();
  } catch {
    return { ok: false, response: json({ error: "failed to read body" }, 400) };
  }
  if (buf.byteLength > limitBytes) {
    return { ok: false, response: json({ error: `body exceeds ${label}` }, 413) };
  }
  return { ok: true, rawBody: new TextDecoder().decode(buf) };
}

// ---------------------------------------------------------------------------
// Cursor helpers for keyset pagination
// ---------------------------------------------------------------------------

interface MemoryCursor { ts: number; fp: string; eid: string }
interface CommCursor   { ts: number; fn: string }

function encodeMemoryCursor(ts: number, fp: string, eid: string): string {
  return btoa(JSON.stringify({ ts, fp, eid }));
}

function decodeMemoryCursor(cursor: string): MemoryCursor | null {
  try {
    const d = JSON.parse(atob(cursor));
    if (typeof d.ts === "number" && typeof d.fp === "string" && typeof d.eid === "string") {
      return d as MemoryCursor;
    }
  } catch { /* fall through */ }
  return null;
}

function encodeCommCursor(ts: number, fn: string): string {
  return btoa(JSON.stringify({ ts, fn }));
}

function decodeCommCursor(cursor: string): CommCursor | null {
  try {
    const d = JSON.parse(atob(cursor));
    if (typeof d.ts === "number" && typeof d.fn === "string") {
      return d as CommCursor;
    }
  } catch { /* fall through */ }
  return null;
}

// ---------------------------------------------------------------------------
// DB row types (internal — not exported)
// ---------------------------------------------------------------------------

interface RunBeatRow {
  agent_name: string;
  started_at: number | null;
  ended_at:   number | null;
  duration_s: number | null;
  status:     string;
}

interface DecisionEntryRow {
  decision_id:    string;
  gate:           string | null;
  critic_verdict: string | null;
  payload:        string;
}

interface MemoryEntryRow {
  file_path:     string;
  entry_id:      string;
  type_tag:      string | null;
  title:         string;
  body_md:       string;
  source_run_id: string | null;
  agent_owner:   string | null;
  last_updated:  number;
}

interface CommMessageRow {
  filename:         string;
  from_agent:       string;
  to_agent:         string;
  priority:         string;
  thread_id:        string | null;
  parent_id:        string | null;
  subject:          string | null;
  payload:          string;
  ts:               number;
  intake_decision:  string | null;
}

// ---------------------------------------------------------------------------
// A. GET /pipeline/:run_id/summary
// ---------------------------------------------------------------------------

export async function handleGetPipelineSummary(
  request: Request,
  env: V4Env,
  run_id: string
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  if (!validateRunId(run_id)) return json({ error: "invalid run_id" }, 400);

  // 1. Pipeline detail (provides run metadata + comms)
  const pdRow = await env.DASHBOARD_DB
    .prepare(
      "SELECT pipeline_type, status, payload, started_at, ended_at FROM pipeline_detail WHERE run_id=?"
    )
    .bind(run_id)
    .first<{ pipeline_type: string; status: string; payload: string; started_at: number; ended_at: number | null }>();

  if (!pdRow) return json({ error: "run not found" }, 404);

  let pd: Record<string, unknown> = {};
  try { pd = JSON.parse(pdRow.payload) as Record<string, unknown>; } catch { /* use empty */ }

  const pdBeats = Array.isArray(pd.beats) ? pd.beats as Record<string, unknown>[] : [];
  const pdComms = Array.isArray(pd.comms) ? pd.comms as Record<string, unknown>[] : [];
  const pdSummary = pd.summary as Record<string, unknown> | undefined;

  // 2. Agents from run_beat (fall back to pipeline_detail beats if empty)
  const beatsResult = await env.DASHBOARD_DB
    .prepare(
      "SELECT agent_name, started_at, ended_at, duration_s, status" +
      " FROM run_beat WHERE run_id=? ORDER BY started_at ASC NULLS LAST, agent_name ASC"
    )
    .bind(run_id)
    .all<RunBeatRow>();

  type AgentStatus = "waiting" | "running" | "done" | "failed" | "skipped";
  type AgentEntry  = {
    name: string;
    status: AgentStatus;
    started_at: string | null;
    duration_s: number | null;
    output_path: string | null;
    output_excerpt: string | null;
  };

  let agents: AgentEntry[] = beatsResult.results.map((b) => ({
    name:           b.agent_name,
    status:         b.status as AgentStatus,
    started_at:     b.started_at ? new Date(b.started_at).toISOString() : null,
    duration_s:     b.duration_s ?? null,
    output_path:    null,
    output_excerpt: null,
  }));

  // Fallback to pipeline_detail beats if run_beat is empty
  if (agents.length === 0) {
    agents = pdBeats.map((beat) => ({
      name:           String(beat.agent_id ?? ""),
      status:         (beat.state as AgentStatus) ?? "waiting",
      started_at:     beat.started_at ? String(beat.started_at) : null,
      duration_s:     typeof beat.duration_s === "number" ? beat.duration_s : null,
      output_path:    beat.output_file ? String(beat.output_file) : null,
      output_excerpt: beat.output_excerpt ? String(beat.output_excerpt).slice(0, 400) : null,
    }));
  } else {
    // Enrich agents with output_path/excerpt from pipeline_detail beats
    const beatByAgent: Record<string, Record<string, unknown>> = {};
    for (const b of pdBeats) {
      if (b.agent_id) beatByAgent[String(b.agent_id)] = b;
    }
    agents = agents.map((a) => {
      const pb = beatByAgent[a.name];
      if (!pb) return a;
      return {
        ...a,
        output_path:    pb.output_file ? String(pb.output_file) : null,
        output_excerpt: pb.output_excerpt ? String(pb.output_excerpt).slice(0, 400) : null,
      };
    });
  }

  // 3. Outputs from pipeline_detail beats
  const outputs: { path: string; agent: string; title: string; verdict?: string; body_md: string }[] = [];
  for (const beat of pdBeats) {
    if (!beat.output_file) continue;
    const filePath = String(beat.output_file);
    const filename = filePath.split("/").pop() ?? filePath;
    const rawExcerpt = beat.output_excerpt ? String(beat.output_excerpt) : "";
    const verdictMatch = rawExcerpt.match(/VERDICT\s*[:—\-]+\s*(PASS|FAIL|BLOCKED|GREEN|BLOCKING)/i);
    outputs.push({
      path:   filePath,
      agent:  String(beat.agent_id ?? "unknown"),
      title:  filename.replace(/\.md$/, ""),
      ...(verdictMatch ? { verdict: verdictMatch[1].toUpperCase() } : {}),
      body_md: rawExcerpt.slice(0, 400),
    });
  }

  // 4. Decisions from decision_entry
  const decisionsResult = await env.DASHBOARD_DB
    .prepare(
      "SELECT decision_id, gate, critic_verdict, payload FROM decision_entry WHERE run_id=? ORDER BY decision_id ASC"
    )
    .bind(run_id)
    .all<DecisionEntryRow>();

  const decisions = decisionsResult.results.map((d) => {
    let title = d.decision_id;
    try {
      const p = JSON.parse(d.payload) as Record<string, unknown>;
      title = typeof p.title === "string" ? p.title : d.decision_id;
    } catch { /* use decision_id */ }
    return {
      id:      d.decision_id,
      gate:    d.gate,
      verdict: d.critic_verdict,
      title,
    };
  });

  // 5. Comms counts from pipeline_detail.comms
  const comms_count = pdComms.length;
  const p0_count    = pdComms.filter((c) => c.priority === "p0").length;

  // 6. Task tree from task_tree_snapshot
  let task_tree: { nodes: unknown[]; edges: unknown[] } | undefined;
  const ttRow = await env.DASHBOARD_DB
    .prepare("SELECT payload FROM task_tree_snapshot WHERE run_id=?")
    .bind(run_id)
    .first<{ payload: string }>();

  if (ttRow) {
    try {
      const tasks = JSON.parse(ttRow.payload) as Record<string, unknown>;
      const taskList = Array.isArray(tasks.tasks) ? tasks.tasks as Record<string, unknown>[] : [];
      const nodes = taskList.map((t) => ({
        id:           String(t.id ?? ""),
        owner:        String(t.owner ?? "unknown"),
        title:        String(t.title ?? t.id ?? ""),
        status:       String(t.status ?? "pending"),
        estimate_min: typeof t.estimate_min === "number" ? t.estimate_min : 0,
      }));
      const edges: { from: string; to: string }[] = [];
      for (const t of taskList) {
        const blockedBy = Array.isArray(t.blocked_by) ? t.blocked_by as string[] : [];
        for (const dep of blockedBy) {
          edges.push({ from: dep, to: String(t.id ?? "") });
        }
      }
      if (nodes.length > 0) {
        task_tree = { nodes, edges };
      }
    } catch { /* skip malformed payload */ }
  }

  const responseBody = {
    run_id,
    pipeline:    pdRow.pipeline_type ?? String(pd.pipeline_type ?? "unknown"),
    task:        String(pdSummary?.task ?? ""),
    started_at:  new Date(pdRow.started_at).toISOString(),
    ended_at:    pdRow.ended_at ? new Date(pdRow.ended_at).toISOString() : null,
    status:      pdRow.status as "live" | "done" | "failed" | "blocked",
    agents,
    outputs,
    decisions,
    comms_count,
    p0_count,
    ...(task_tree ? { task_tree } : {}),
  };

  const validated = PipelineSummaryResponseSchema.safeParse(responseBody);
  if (!validated.success) {
    return json({ error: "response shape invalid", detail: validated.error.issues[0] }, 500);
  }

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// B. GET /outputs/:run_id/:filename
// SSRF-validated: run_id + filename regexed; path traversal blocked.
// 5-min CF Worker cache.
// ---------------------------------------------------------------------------

export async function handleGetOutputFile(
  request: Request,
  env: V4Env,
  run_id: string,
  filename: string
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  // SSRF validation
  if (!validateRunId(run_id)) return json({ error: "invalid run_id" }, 400);
  if (!validateFilename(filename)) return json({ error: "invalid filename" }, 400);

  // 5-min Cache API
  const cacheKey = new Request(`https://v4-outputs.internal/${run_id}/${filename}`);
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const row = await env.DASHBOARD_DB
    .prepare("SELECT content_md FROM output_file WHERE run_id=? AND filename=?")
    .bind(run_id, filename)
    .first<{ content_md: string }>();

  if (!row) return json({ error: "output file not found" }, 404);

  // Enforce 256 KB content cap (daemon enforces at push time; double-check here)
  const MAX_CONTENT = 256 * 1024;
  const content_md  = row.content_md.length > MAX_CONTENT
    ? row.content_md.slice(0, MAX_CONTENT)
    : row.content_md;

  const body      = { run_id, filename, content_md };
  const validated = OutputFileResponseSchema.safeParse(body);
  if (!validated.success) {
    return json({ error: "response shape invalid" }, 500);
  }

  const resp = new Response(JSON.stringify(validated.data), {
    status:  200,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "public, max-age=300",   // 5 min
    },
  });
  cache.put(cacheKey, resp.clone());             // fire-and-forget
  return resp;
}

// ---------------------------------------------------------------------------
// C. GET /now/conveyor
// ---------------------------------------------------------------------------

export async function handleGetConveyor(
  request: Request,
  env: V4Env
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const now = Date.now();
  // Midnight UTC today in ms
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const midnightMs = midnight.getTime();

  // Active runs: pipeline_detail where status='live'
  const activeResult = await env.DASHBOARD_DB
    .prepare(
      "SELECT run_id, pipeline_type, status, payload, started_at" +
      " FROM pipeline_detail WHERE status='live' ORDER BY started_at DESC LIMIT 20"
    )
    .all<{ run_id: string; pipeline_type: string; status: string; payload: string; started_at: number }>();

  // Finished today
  const finishedResult = await env.DASHBOARD_DB
    .prepare(
      "SELECT run_id, pipeline_type, status, ended_at FROM pipeline_detail" +
      " WHERE status IN ('done','failed','blocked') AND ended_at >= ? ORDER BY ended_at DESC LIMIT 50"
    )
    .bind(midnightMs)
    .all<{ run_id: string; pipeline_type: string; status: string; ended_at: number }>();

  // Build active_runs (need current_agent from run_beat)
  const active_runs: {
    run_id: string;
    current_stage: string;
    current_agent: string;
    elapsed_s: number;
    started_at: string;
    task_excerpt: string;
  }[] = [];

  for (const row of activeResult.results) {
    // Last running agent for this run
    const runningAgent = await env.DASHBOARD_DB
      .prepare(
        "SELECT agent_name FROM run_beat WHERE run_id=? AND status='running'" +
        " ORDER BY started_at DESC NULLS LAST LIMIT 1"
      )
      .bind(row.run_id)
      .first<{ agent_name: string }>();

    const current_agent = runningAgent?.agent_name ?? row.pipeline_type;
    const current_stage = AGENT_TO_STAGE[current_agent] ?? "dev_lead+team";
    const elapsed_s     = Math.floor((now - row.started_at) / 1000);

    let task_excerpt = "";
    try {
      const pd = JSON.parse(row.payload) as Record<string, unknown>;
      const summary = pd.summary as Record<string, unknown> | undefined;
      task_excerpt = String(summary?.task ?? pd.task ?? "").slice(0, 200);
    } catch { /* skip */ }

    active_runs.push({
      run_id:        row.run_id,
      current_stage,
      current_agent,
      elapsed_s,
      started_at:    new Date(row.started_at).toISOString(),
      task_excerpt,
    });
  }

  // Build finished_today
  type FinishedStatus = "done" | "failed" | "blocked";
  const finished_today = finishedResult.results.map((row) => ({
    run_id:     row.run_id,
    last_stage: row.pipeline_type ?? "unknown",
    ended_at:   new Date(row.ended_at).toISOString(),
    status:     row.status as FinishedStatus,
  }));

  const responseBody = {
    stages:         CONVEYOR_STAGES.map((s) => ({ name: s.name, agents: [...s.agents] })),
    active_runs,
    finished_today,
  };

  const validated = ConveyorResponseSchema.safeParse(responseBody);
  if (!validated.success) {
    return json({ error: "response shape invalid", detail: validated.error.issues[0] }, 500);
  }

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// D. GET /agents/avatars
// ---------------------------------------------------------------------------

export async function handleGetAgentAvatars(
  request: Request,
  env: V4Env
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const result = await env.DASHBOARD_DB
    .prepare(
      "SELECT agent_name, seed, display_name, role_tier, color_token" +
      " FROM agent_avatar ORDER BY agent_name ASC"
    )
    .all<{ agent_name: string; seed: number; display_name: string; role_tier: string; color_token: string }>();

  const body      = { agents: result.results };
  const validated = AgentAvatarsResponseSchema.safeParse(body);
  if (!validated.success) {
    return json({ error: "response shape invalid", detail: validated.error.issues[0] }, 500);
  }

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// E. GET /memory/entries
// Query params: type_tag?, agent_owner?, q? (FTS5), since? (ISO), cursor?
// Page size: 20. Keyset cursor: base64(JSON{ts, fp, eid}).
// ---------------------------------------------------------------------------

export async function handleGetMemoryEntries(
  request: Request,
  env: V4Env
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const url        = new URL(request.url);
  const type_tag   = url.searchParams.get("type_tag");
  const agent_owner = url.searchParams.get("agent_owner");
  const q          = url.searchParams.get("q");
  const since_raw  = url.searchParams.get("since");
  const cursor_raw = url.searchParams.get("cursor");

  const PAGE_SIZE = 20;
  const FETCH_N   = PAGE_SIZE + 1;   // fetch one extra to detect next page

  const since_ms = since_raw ? new Date(since_raw).getTime() : null;
  const cursor   = cursor_raw ? decodeMemoryCursor(cursor_raw) : null;

  let entries: MemoryEntryRow[];

  if (q) {
    // FTS5 path: search_index → join memory_entry
    // D1 note: FTS5 MATCH with type filter via regular WHERE clause
    const ftsResult = await env.DASHBOARD_DB
      .prepare(
        "SELECT ref_id FROM search_index WHERE search_index MATCH ? AND type='memory' LIMIT ?"
      )
      .bind(q, FETCH_N)
      .all<{ ref_id: string }>();

    if (ftsResult.results.length === 0) {
      entries = [];
    } else {
      // Parse ref_ids: "file_path:entry_id" (first ':' is the separator)
      const pairs: { fp: string; eid: string }[] = [];
      for (const row of ftsResult.results) {
        const colonIdx = row.ref_id.indexOf(":");
        if (colonIdx === -1) continue;
        pairs.push({ fp: row.ref_id.slice(0, colonIdx), eid: row.ref_id.slice(colonIdx + 1) });
      }

      // Batch-fetch memory_entry rows
      const stmts = pairs.map((p) =>
        env.DASHBOARD_DB
          .prepare(
            "SELECT file_path, entry_id, type_tag, title, body_md, source_run_id, agent_owner, last_updated" +
            " FROM memory_entry WHERE file_path=? AND entry_id=?"
          )
          .bind(p.fp, p.eid)
      );

      const batchRes = await env.DASHBOARD_DB.batch<MemoryEntryRow>(stmts);
      entries = batchRes
        .flatMap((r) => r.results)
        .filter((r): r is MemoryEntryRow => r !== null && r !== undefined);
    }
  } else {
    // Regular filter path — keyset pagination on (last_updated DESC, file_path ASC, entry_id ASC)
    let sql: string;
    let bindings: (string | number | null)[];

    if (cursor) {
      sql =
        "SELECT file_path, entry_id, type_tag, title, body_md, source_run_id, agent_owner, last_updated" +
        " FROM memory_entry" +
        " WHERE (? IS NULL OR type_tag = ?)" +
        "   AND (? IS NULL OR agent_owner = ?)" +
        "   AND (? IS NULL OR last_updated >= ?)" +
        "   AND (" +
        "         last_updated < ?" +
        "      OR (last_updated = ? AND file_path > ?)" +
        "      OR (last_updated = ? AND file_path = ? AND entry_id > ?)" +
        "   )" +
        " ORDER BY last_updated DESC, file_path ASC, entry_id ASC" +
        " LIMIT ?";
      bindings = [
        type_tag, type_tag,
        agent_owner, agent_owner,
        since_ms, since_ms,
        cursor.ts,
        cursor.ts, cursor.fp,
        cursor.ts, cursor.fp, cursor.eid,
        FETCH_N,
      ];
    } else {
      sql =
        "SELECT file_path, entry_id, type_tag, title, body_md, source_run_id, agent_owner, last_updated" +
        " FROM memory_entry" +
        " WHERE (? IS NULL OR type_tag = ?)" +
        "   AND (? IS NULL OR agent_owner = ?)" +
        "   AND (? IS NULL OR last_updated >= ?)" +
        " ORDER BY last_updated DESC, file_path ASC, entry_id ASC" +
        " LIMIT ?";
      bindings = [type_tag, type_tag, agent_owner, agent_owner, since_ms, since_ms, FETCH_N];
    }

    // D1 .bind() accepts positional args — spread array
    const stmt = env.DASHBOARD_DB.prepare(sql);
    // @ts-ignore — D1 .bind() is variadic; spread is correct at runtime
    const result = await stmt.bind(...bindings).all<MemoryEntryRow>();
    entries = result.results;
  }

  // Compute next cursor
  const hasMore = entries.length > PAGE_SIZE;
  const page    = hasMore ? entries.slice(0, PAGE_SIZE) : entries;
  const nextCursor: string | null = hasMore
    ? encodeMemoryCursor(
        page[PAGE_SIZE - 1].last_updated,
        page[PAGE_SIZE - 1].file_path,
        page[PAGE_SIZE - 1].entry_id
      )
    : null;

  const responseBody = {
    entries: page.map((e) => ({
      file_path:     e.file_path,
      entry_id:      e.entry_id,
      type_tag:      e.type_tag,
      title:         e.title,
      body_md:       e.body_md,
      source_run_id: e.source_run_id,
      last_updated:  new Date(e.last_updated).toISOString(),
      agent_owner:   e.agent_owner,
    })),
    cursor: nextCursor,
  };

  const validated = MemoryEntriesResponseSchema.safeParse(responseBody);
  if (!validated.success) {
    return json({ error: "response shape invalid", detail: validated.error.issues[0] }, 500);
  }

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// F. GET /comms/feed
// Query params: priority?, from?, to?, since? (ISO), intake_decision?, cursor?
// Page size: 30. Keyset cursor: base64(JSON{ts, fn}).
// Channel auto-detected: thread_id IS NOT NULL → 'thread',
//   filename has '_cc_' → 'sub_agent_cc', else → 'flat'.
// ---------------------------------------------------------------------------

export async function handleGetCommsFeed(
  request: Request,
  env: V4Env
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const url              = new URL(request.url);
  const priority_filter  = url.searchParams.get("priority");
  const from_filter      = url.searchParams.get("from");
  const to_filter        = url.searchParams.get("to");
  const since_raw        = url.searchParams.get("since");
  const intake_filter    = url.searchParams.get("intake_decision");
  const cursor_raw       = url.searchParams.get("cursor");

  const PAGE_SIZE = 30;
  const FETCH_N   = PAGE_SIZE + 1;

  const since_ms = since_raw ? new Date(since_raw).getTime() : null;
  const cursor   = cursor_raw ? decodeCommCursor(cursor_raw) : null;

  let sql: string;
  let bindings: (string | number | null)[];

  const WHERE_FILTERS =
    "  (? IS NULL OR priority = ?)" +
    " AND (? IS NULL OR from_agent = ?)" +
    " AND (? IS NULL OR to_agent = ?)" +
    " AND (? IS NULL OR ts >= ?)" +
    " AND (? IS NULL OR intake_decision = ?)";

  const commonBindings: (string | number | null)[] = [
    priority_filter,  priority_filter,
    from_filter,      from_filter,
    to_filter,        to_filter,
    since_ms,         since_ms,
    intake_filter,    intake_filter,
  ];

  if (cursor) {
    sql =
      "SELECT filename, from_agent, to_agent, priority, thread_id, parent_id, subject," +
      "       payload, ts, intake_decision" +
      " FROM comm_message" +
      " WHERE " + WHERE_FILTERS +
      "   AND (ts < ? OR (ts = ? AND filename > ?))" +
      " ORDER BY ts DESC, filename ASC" +
      " LIMIT ?";
    bindings = [...commonBindings, cursor.ts, cursor.ts, cursor.fn, FETCH_N];
  } else {
    sql =
      "SELECT filename, from_agent, to_agent, priority, thread_id, parent_id, subject," +
      "       payload, ts, intake_decision" +
      " FROM comm_message" +
      " WHERE " + WHERE_FILTERS +
      " ORDER BY ts DESC, filename ASC" +
      " LIMIT ?";
    bindings = [...commonBindings, FETCH_N];
  }

  const stmt = env.DASHBOARD_DB.prepare(sql);
  // @ts-ignore — variadic bind
  const result = await stmt.bind(...bindings).all<CommMessageRow>();

  const rows = result.results;
  const hasMore   = rows.length > PAGE_SIZE;
  const page      = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor: string | null = hasMore
    ? encodeCommCursor(page[PAGE_SIZE - 1].ts, page[PAGE_SIZE - 1].filename)
    : null;

  type Channel = "flat" | "thread" | "sub_agent_cc";
  type Priority = "p0" | "p1" | "p2";

  const messages = page.map((row) => {
    let channel: Channel = "flat";
    if (row.thread_id) {
      channel = "thread";
    } else if (row.filename.includes("_cc_")) {
      channel = "sub_agent_cc";
    }

    const msg: Record<string, unknown> = {
      filename:  row.filename,
      from:      row.from_agent,
      to:        row.to_agent,
      priority:  (row.priority || "p2") as Priority,
      channel,
      subject:   row.subject ?? null,
      body_md:   row.payload,
      ts:        new Date(row.ts).toISOString(),
    };
    if (row.thread_id) msg.thread_id = row.thread_id;
    if (row.parent_id) msg.parent_id = row.parent_id;
    if (row.intake_decision !== undefined) msg.intake_decision = row.intake_decision;
    return msg;
  });

  const responseBody = { messages, cursor: nextCursor };
  const validated    = CommsFeedResponseSchema.safeParse(responseBody);
  if (!validated.success) {
    return json({ error: "response shape invalid", detail: validated.error.issues[0] }, 500);
  }

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// G. GET /runs/:run_id/task-tree
// 1h CF Worker cache.
// ---------------------------------------------------------------------------

export async function handleGetTaskTree(
  request: Request,
  env: V4Env,
  run_id: string
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  if (!validateRunId(run_id)) return json({ error: "invalid run_id" }, 400);

  // 1h Cache API
  const cacheKey = new Request(`https://v4-tasktree.internal/${run_id}`);
  const cache    = caches.default;
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const row = await env.DASHBOARD_DB
    .prepare("SELECT payload, captured_at FROM task_tree_snapshot WHERE run_id=?")
    .bind(run_id)
    .first<{ payload: string; captured_at: number }>();

  let payload: unknown = null;
  let cached_at: string | null = null;

  if (row) {
    try {
      payload    = JSON.parse(row.payload);
      cached_at  = new Date(row.captured_at).toISOString();
    } catch {
      payload   = null;
      cached_at = null;
    }
  }

  const body      = { run_id, payload, cached_at };
  const validated = TaskTreeResponseSchema.safeParse(body);
  if (!validated.success) {
    return json({ error: "response shape invalid", detail: validated.error.issues[0] }, 500);
  }

  const resp = new Response(JSON.stringify(validated.data), {
    status:  200,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "public, max-age=3600",   // 1h
    },
  });
  cache.put(cacheKey, resp.clone());               // fire-and-forget
  return resp;
}

// ===========================================================================
// INGEST handlers (bearer auth)
// ===========================================================================

// ---------------------------------------------------------------------------
// POST /ingest/v4/intake-decisions
// Body: { updates: [{ filename: string, intake_decision: 'READY' | 'NEED_MORE_INFO' }] }
// Action: UPDATE comm_message SET intake_decision=? WHERE filename=?
// Idempotent — safe to re-run.
// ---------------------------------------------------------------------------

export async function handleIngestIntakeDecisions(
  request: Request,
  env: V4Env
): Promise<Response> {
  const authErr = await requireBearer(request, env);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_INTAKE_DECISIONS, "64 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).updates)) {
    return json({ error: "expected { updates: [...] }" }, 400);
  }

  const updates = (parsed as { updates: unknown[] }).updates;
  if (updates.length === 0) return new Response(null, { status: 204 });

  const valid: { filename: string; intake_decision: string }[] = [];
  for (const u of updates) {
    if (
      u &&
      typeof u === "object" &&
      typeof (u as Record<string, unknown>).filename === "string" &&
      ["READY", "NEED_MORE_INFO"].includes(String((u as Record<string, unknown>).intake_decision))
    ) {
      valid.push({
        filename:        String((u as Record<string, unknown>).filename),
        intake_decision: String((u as Record<string, unknown>).intake_decision),
      });
    }
  }

  if (valid.length === 0) return new Response(null, { status: 204 });

  const stmts = valid.map((u) =>
    env.DASHBOARD_DB
      .prepare("UPDATE comm_message SET intake_decision=? WHERE filename=? AND intake_decision IS NULL")
      .bind(u.intake_decision, u.filename)
  );

  for (let i = 0; i < stmts.length; i += 50) {
    try {
      await env.DASHBOARD_DB.batch(stmts.slice(i, i + 50));
    } catch {
      return json({ error: "storage write failed" }, 500);
    }
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// POST /ingest/v4/memory-entries
// Body: { file_path: string, entries: [...], last_updated: number }
// Action: upsert memory_entry rows; delete orphans for this file_path.
// FTS5 triggers handle search_index propagation automatically.
// ---------------------------------------------------------------------------

export async function handleIngestMemoryEntries(
  request: Request,
  env: V4Env
): Promise<Response> {
  const authErr = await requireBearer(request, env);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_MEMORY_ENTRIES, "256 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  if (!parsed || typeof parsed !== "object") return json({ error: "expected object" }, 400);
  const body = parsed as Record<string, unknown>;

  const file_path    = typeof body.file_path === "string" ? body.file_path : null;
  const entries_raw  = Array.isArray(body.entries) ? body.entries as unknown[] : [];
  const last_updated = typeof body.last_updated === "number" ? body.last_updated : Date.now();

  if (!file_path) return json({ error: "file_path required" }, 400);
  if (entries_raw.length === 0) {
    // File now has no sections — delete all existing entries for this file
    await env.DASHBOARD_DB
      .prepare("DELETE FROM memory_entry WHERE file_path=?")
      .bind(file_path)
      .run();
    return new Response(null, { status: 204 });
  }

  type MemoryEntryInput = {
    entry_id: string;
    type_tag: string | null;
    title: string;
    body_md: string;
    source_run_id: string | null;
    agent_owner: string | null;
  };

  const entries: MemoryEntryInput[] = [];
  for (const e of entries_raw) {
    if (!e || typeof e !== "object") continue;
    const row = e as Record<string, unknown>;
    if (typeof row.entry_id !== "string" || typeof row.title !== "string") continue;
    entries.push({
      entry_id:      String(row.entry_id),
      type_tag:      typeof row.type_tag === "string" ? row.type_tag : null,
      title:         String(row.title),
      body_md:       typeof row.body_md === "string" ? row.body_md : "",
      source_run_id: typeof row.source_run_id === "string" ? row.source_run_id : null,
      agent_owner:   typeof row.agent_owner === "string" ? row.agent_owner : null,
    });
  }

  if (entries.length === 0) return new Response(null, { status: 204 });

  const stmts: D1PreparedStatement[] = [];

  // Upsert each entry (FTS5 triggers fire automatically)
  for (const e of entries) {
    stmts.push(
      env.DASHBOARD_DB
        .prepare(
          "INSERT OR REPLACE INTO memory_entry" +
          " (file_path, entry_id, type_tag, title, body_md, source_run_id, agent_owner, last_updated)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(file_path, e.entry_id, e.type_tag, e.title, e.body_md, e.source_run_id, e.agent_owner, last_updated)
    );
  }

  // Delete orphan entries (headings removed from file)
  const entry_ids_csv = entries.map(() => "?").join(",");
  const orphanEntry   = entries.map((e) => e.entry_id) as string[];
  stmts.push(
    env.DASHBOARD_DB
      .prepare(`DELETE FROM memory_entry WHERE file_path=? AND entry_id NOT IN (${entry_ids_csv})`)
      // @ts-ignore — variadic
      .bind(file_path, ...orphanEntry)
  );

  for (let i = 0; i < stmts.length; i += 50) {
    try {
      await env.DASHBOARD_DB.batch(stmts.slice(i, i + 50));
    } catch {
      return json({ error: "storage write failed" }, 500);
    }
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// POST /ingest/v4/run-beats
// Body: { run_id: string, beats: [{ agent_name, started_at, ended_at, duration_s, status }] }
// Action: upsert run_beat rows. Idempotent (INSERT OR REPLACE on PK).
// ---------------------------------------------------------------------------

export async function handleIngestRunBeats(
  request: Request,
  env: V4Env
): Promise<Response> {
  const authErr = await requireBearer(request, env);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_RUN_BEATS, "64 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  if (!parsed || typeof parsed !== "object") return json({ error: "expected object" }, 400);
  const body = parsed as Record<string, unknown>;

  const run_id = typeof body.run_id === "string" ? body.run_id : null;
  if (!run_id || !validateRunId(run_id)) return json({ error: "invalid or missing run_id" }, 400);

  const beats_raw = Array.isArray(body.beats) ? body.beats as unknown[] : [];
  if (beats_raw.length === 0) return new Response(null, { status: 204 });

  const VALID_STATUSES = new Set(["waiting", "running", "done", "failed", "skipped"]);

  const stmts: D1PreparedStatement[] = [];
  for (const b of beats_raw) {
    if (!b || typeof b !== "object") continue;
    const row = b as Record<string, unknown>;
    const agent_name = typeof row.agent_name === "string" ? row.agent_name : null;
    if (!agent_name) continue;
    const status = typeof row.status === "string" && VALID_STATUSES.has(row.status) ? row.status : "waiting";
    const started_at = typeof row.started_at === "number" ? row.started_at : null;
    const ended_at   = typeof row.ended_at   === "number" ? row.ended_at   : null;
    const duration_s = typeof row.duration_s === "number" ? row.duration_s : null;

    stmts.push(
      env.DASHBOARD_DB
        .prepare(
          "INSERT OR REPLACE INTO run_beat (run_id, agent_name, started_at, ended_at, duration_s, status)" +
          " VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(run_id, agent_name, started_at, ended_at, duration_s, status)
    );
  }

  if (stmts.length === 0) return new Response(null, { status: 204 });

  for (let i = 0; i < stmts.length; i += 50) {
    try {
      await env.DASHBOARD_DB.batch(stmts.slice(i, i + 50));
    } catch {
      return json({ error: "storage write failed" }, 500);
    }
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// POST /ingest/v4/task-tree/:run_id
// Body: { payload: string, captured_at: number }
//   payload = raw tasks.json content as JSON string.
// Action: INSERT OR REPLACE INTO task_tree_snapshot. Idempotent.
// ---------------------------------------------------------------------------

export async function handleIngestTaskTree(
  request: Request,
  env: V4Env,
  run_id: string
): Promise<Response> {
  const authErr = await requireBearer(request, env);
  if (authErr) return authErr;

  if (!validateRunId(run_id)) return json({ error: "invalid run_id" }, 400);

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_TASK_TREE, "64 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  if (!parsed || typeof parsed !== "object") return json({ error: "expected object" }, 400);
  const body = parsed as Record<string, unknown>;

  const payload     = typeof body.payload === "string" ? body.payload : JSON.stringify(body.payload ?? null);
  const captured_at = typeof body.captured_at === "number" ? body.captured_at : Date.now();

  try {
    await env.DASHBOARD_DB
      .prepare(
        "INSERT OR REPLACE INTO task_tree_snapshot (run_id, payload, captured_at) VALUES (?, ?, ?)"
      )
      .bind(run_id, payload, captured_at)
      .run();
  } catch {
    return json({ error: "storage write failed" }, 500);
  }

  // Evict CF Cache for this run's task-tree (stale 1h entry would block updates)
  const cacheKey = new Request(`https://v4-tasktree.internal/${run_id}`);
  caches.default.delete(cacheKey);    // fire-and-forget

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// POST /ingest/v4/outputs/:run_id
// Body: { files: [{ filename: string, content_md: string }] }
// SSRF-validates filenames. Enforces 256 KB per file. Idempotent.
// ---------------------------------------------------------------------------

export async function handleIngestOutputFiles(
  request: Request,
  env: V4Env,
  run_id: string
): Promise<Response> {
  const authErr = await requireBearer(request, env);
  if (authErr) return authErr;

  if (!validateRunId(run_id)) return json({ error: "invalid run_id" }, 400);

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_OUTPUT_FILES, "512 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  if (!parsed || typeof parsed !== "object") return json({ error: "expected object" }, 400);
  const body = parsed as Record<string, unknown>;
  const files_raw = Array.isArray(body.files) ? body.files as unknown[] : [];
  if (files_raw.length === 0) return new Response(null, { status: 204 });

  const MAX_FILE_BYTES = 256 * 1024;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  for (const f of files_raw) {
    if (!f || typeof f !== "object") continue;
    const row = f as Record<string, unknown>;
    const filename   = typeof row.filename   === "string" ? row.filename   : null;
    const content_md = typeof row.content_md === "string" ? row.content_md : null;
    if (!filename || !content_md) continue;
    if (!validateFilename(filename)) continue;   // SSRF guard on filename
    const capped = content_md.length > MAX_FILE_BYTES
      ? content_md.slice(0, MAX_FILE_BYTES)
      : content_md;

    stmts.push(
      env.DASHBOARD_DB
        .prepare(
          "INSERT OR REPLACE INTO output_file (run_id, filename, content_md, updated_at)" +
          " VALUES (?, ?, ?, ?)"
        )
        .bind(run_id, filename, capped, now)
    );
  }

  if (stmts.length === 0) return new Response(null, { status: 204 });

  for (let i = 0; i < stmts.length; i += 50) {
    try {
      await env.DASHBOARD_DB.batch(stmts.slice(i, i + 50));
    } catch {
      return json({ error: "storage write failed" }, 500);
    }
  }

  return new Response(null, { status: 204 });
}
