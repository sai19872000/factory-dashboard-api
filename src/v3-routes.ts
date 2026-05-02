/**
 * v3 Aura dashboard route handlers.
 *
 * READ endpoints (CF Access JWT-gated):
 *   GET /runs
 *   GET /memory
 *   GET /memory/agents/:name
 *   GET /decisions
 *   GET /decisions/:run_id
 *   GET /decisions/:run_id/:did
 *   GET /comms
 *   GET /comms/threads
 *   GET /comms/thread/:thread_id
 *   GET /brainstorms
 *   GET /brainstorms/:session_id
 *   GET /projects/:name/health   (SSRF-guarded proxy)
 *   GET /search?q=&types=&limit=
 *
 * INGEST endpoints (bearer auth, body-size capped):
 *   POST /ingest/memory          (256 KB)
 *   POST /ingest/decisions       (256 KB)
 *   POST /ingest/comms           (350 KB)
 *   POST /ingest/brainstorms     (350 KB)
 */

import { validateBearer } from "./auth-bearer";
import { validateCfAccessJwt } from "./auth-cf-access";
import {
  IngestMemorySchema,
  IngestDecisionsSchema,
  IngestCommsSchema,
  IngestBrainstormsSchema,
  SearchQuerySchema,
  SEARCH_TYPES,
  type SearchType,
} from "./v3-schema";
import { buildHealthTarget, fetchHealth } from "./ssrf";

// ---------------------------------------------------------------------------
// Env interface (re-exported so index.ts can merge)
// ---------------------------------------------------------------------------

export interface V3Env {
  DASHBOARD_DB: D1Database;
  INGEST_TOKEN: string;
  CF_ACCESS_AUD_SNAPSHOT: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  ALLOWED_EMAIL?: string;
  __STATIC_CONTENT?: unknown; // present in Pages functions, unused here
}

// ---------------------------------------------------------------------------
// Body size limits for the four new ingest routes
// ---------------------------------------------------------------------------

const LIMIT_MEMORY     = 512 * 1024;
const LIMIT_DECISIONS  = 256 * 1024;
const LIMIT_COMMS      = 350 * 1024;
const LIMIT_BRAINSTORMS = 350 * 1024;

const ALLOWED_EMAIL_DEFAULT = "sai19872000@gmail.com";

// ---------------------------------------------------------------------------
// Helpers (duplicated from index.ts intentionally — avoids circular deps)
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
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

async function requireBearer(request: Request, token: string): Promise<Response | null> {
  const r = validateBearer(request, token);
  if (!r.ok) return new Response(null, { status: 401 });
  return null;
}

async function requireCfAccess(
  request: Request,
  env: V3Env
): Promise<Response | null> {
  const email = env.ALLOWED_EMAIL ?? ALLOWED_EMAIL_DEFAULT;
  const result = await validateCfAccessJwt(
    request,
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD_SNAPSHOT,
    email
  );
  if (!result.ok) return new Response(null, { status: result.status });
  return null;
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// INGEST — POST /ingest/memory
// ---------------------------------------------------------------------------

export async function handleIngestMemory(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireBearer(request, env.INGEST_TOKEN);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_MEMORY, "256 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schema = IngestMemorySchema.safeParse(parsed);
  if (!schema.success) return json({ error: "invalid memory schema" }, 400);

  const data = schema.data;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  // UPSERT MEMORY.md root file
  const memHash = await sha256Hex(data.MEMORY_md);
  stmts.push(
    env.DASHBOARD_DB.prepare(
      "INSERT INTO memory_file (path, payload, parsed_json, content_hash, updated_at) VALUES (?, ?, NULL, ?, ?)" +
      " ON CONFLICT(path) DO UPDATE SET payload=excluded.payload, content_hash=excluded.content_hash, updated_at=excluded.updated_at" +
      " WHERE excluded.content_hash != memory_file.content_hash"
    ).bind("MEMORY.md", data.MEMORY_md, memHash, now)
  );

  // Also upsert FTS5 row for MEMORY.md
  stmts.push(
    env.DASHBOARD_DB.prepare(
      "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
    ).bind("memory", "MEMORY.md", "/memory", "MEMORY.md", data.MEMORY_md.slice(0, 4000))
  );

  // UPSERT each agents/*.md file
  for (const [name, file] of Object.entries(data.agents ?? {})) {
    const path = `agents/${name}.md`;
    const hash = file.content_hash ?? (await sha256Hex(file.content));
    const parsedJson = file.parsed_json ?? null;
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT INTO memory_file (path, payload, parsed_json, content_hash, updated_at) VALUES (?,?,?,?,?)" +
        " ON CONFLICT(path) DO UPDATE SET payload=excluded.payload, parsed_json=excluded.parsed_json, content_hash=excluded.content_hash, updated_at=excluded.updated_at" +
        " WHERE excluded.content_hash != memory_file.content_hash"
      ).bind(path, file.content, parsedJson, hash, file.mtime ?? now)
    );
    // FTS5 for this agent memory file
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
      ).bind("memory", path, `/memory/agents/${name}`, `Agent Memory: ${name}`, file.content.slice(0, 4000))
    );
  }

  // Batch in groups of 50 (D1 batch limit)
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
// INGEST — POST /ingest/decisions
// ---------------------------------------------------------------------------

export async function handleIngestDecisions(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireBearer(request, env.INGEST_TOKEN);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_DECISIONS, "256 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schema = IngestDecisionsSchema.safeParse(parsed);
  if (!schema.success) return json({ error: "invalid decisions schema" }, 400);

  const { run_id, decisions } = schema.data;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  for (const d of decisions) {
    const pk = `${run_id}:${d.decision_id}`;
    const payloadStr = JSON.stringify(d);
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT INTO decision_entry (pk, run_id, decision_id, gate, payload, critic_verdict, agent, updated_at)" +
        " VALUES (?,?,?,?,?,?,?,?)" +
        " ON CONFLICT(pk) DO UPDATE SET gate=excluded.gate, payload=excluded.payload," +
        " critic_verdict=excluded.critic_verdict, agent=excluded.agent, updated_at=excluded.updated_at"
      ).bind(pk, run_id, d.decision_id, d.gate ?? null, payloadStr, d.critic_verdict ?? null, d.agent ?? null, now)
    );
    // FTS5 row
    const title = `${d.decision_id}: ${d.title ?? ""}`;
    const body = [d.rationale ?? "", d.self_critique ?? "", (d.options ?? []).join(" ")].join(" ").slice(0, 4000);
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
      ).bind("decision", pk, `/decisions/${run_id}/${d.decision_id}`, title, body)
    );
  }

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
// INGEST — POST /ingest/comms
// ---------------------------------------------------------------------------

export async function handleIngestComms(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireBearer(request, env.INGEST_TOKEN);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_COMMS, "350 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schema = IngestCommsSchema.safeParse(parsed);
  if (!schema.success) return json({ error: "invalid comms schema" }, 400);

  const { messages, threads } = schema.data;
  const now = Date.now();

  // Prune messages older than 14 days before upsert
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;
  const stmts: D1PreparedStatement[] = [
    env.DASHBOARD_DB.prepare("DELETE FROM comm_message WHERE ts < ?").bind(cutoff),
  ];

  for (const m of messages) {
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT INTO comm_message (filename, from_agent, to_agent, subject, priority, thread_id, payload, ts, archived)" +
        " VALUES (?,?,?,?,?,?,?,?,?)" +
        " ON CONFLICT(filename) DO UPDATE SET payload=excluded.payload, archived=excluded.archived"
      ).bind(m.filename, m.from_agent, m.to_agent, m.subject ?? null, m.priority, m.thread_id ?? null, m.payload, m.ts, m.archived)
    );
    // FTS5
    const preview = m.payload.slice(0, 300);
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
      ).bind("comm", m.filename, `/comms#${m.filename}`, m.subject ?? `${m.from_agent}→${m.to_agent}`, preview)
    );
  }

  for (const t of threads) {
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT INTO comm_thread (thread_id, subject, participants_csv, status, started_at, last_ts, message_count)" +
        " VALUES (?,?,?,?,?,?,?)" +
        " ON CONFLICT(thread_id) DO UPDATE SET subject=excluded.subject, participants_csv=excluded.participants_csv," +
        " status=excluded.status, last_ts=excluded.last_ts, message_count=excluded.message_count"
      ).bind(t.thread_id, t.subject ?? null, t.participants_csv, t.status, t.started_at, t.last_ts, t.message_count)
    );
    // FTS5 thread row
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
      ).bind("thread", t.thread_id, `/comms/threads/${t.thread_id}`, t.subject ?? `Thread ${t.thread_id}`, t.participants_csv)
    );
  }

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
// INGEST — POST /ingest/brainstorms
// ---------------------------------------------------------------------------

export async function handleIngestBrainstorms(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireBearer(request, env.INGEST_TOKEN);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_BRAINSTORMS, "350 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schema = IngestBrainstormsSchema.safeParse(parsed);
  if (!schema.success) return json({ error: "invalid brainstorms schema" }, 400);

  const data = schema.data;
  const now = Date.now();
  const chunkPayload = JSON.stringify({ turns: data.turns });
  const chunkHash = await sha256Hex(chunkPayload);

  const stmts: D1PreparedStatement[] = [];

  // Upsert session metadata (only on chunk_idx=0 or if fields present)
  if (data.chunk_idx === 0 || data.started_at !== undefined) {
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT INTO brainstorm_session (session_id, started_at, last_ts, turn_count, outcome, total_chunks)" +
        " VALUES (?,?,?,?,?,?)" +
        " ON CONFLICT(session_id) DO UPDATE SET last_ts=MAX(last_ts, excluded.last_ts)," +
        " turn_count=MAX(turn_count, excluded.turn_count)," +
        " outcome=COALESCE(excluded.outcome, brainstorm_session.outcome)," +
        " total_chunks=excluded.total_chunks"
      ).bind(
        data.session_id,
        data.started_at ?? now,
        data.last_ts ?? now,
        data.turns.length,
        data.outcome ?? null,
        data.total_chunks
      )
    );
  }

  // Upsert chunk
  stmts.push(
    env.DASHBOARD_DB.prepare(
      "INSERT INTO brainstorm_session_chunk (session_id, chunk_idx, payload)" +
      " VALUES (?,?,?)" +
      " ON CONFLICT(session_id, chunk_idx) DO UPDATE SET payload=excluded.payload"
    ).bind(data.session_id, data.chunk_idx, chunkPayload)
  );

  // FTS5 — index first chunk only (title covers the session)
  if (data.chunk_idx === 0) {
    const firstTurn = data.turns[0];
    const bodyText = data.turns.map((t) => t.content).join(" ").slice(0, 4000);
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
      ).bind(
        "brainstorm",
        data.session_id,
        `/brainstorms/${data.session_id}`,
        `Brainstorm ${firstTurn?.ts ?? data.session_id}`,
        bodyText
      )
    );
  }

  try {
    await env.DASHBOARD_DB.batch(stmts);
  } catch {
    return json({ error: "storage write failed" }, 500);
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// READ — GET /runs
// ---------------------------------------------------------------------------

export async function handleGetRuns(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  // Derive run list from pipeline_detail (surface C) — already populated by existing daemon.
  // has_p0: time-range EXISTS join against comm_message — a p0 comm whose ts falls within the
  // run's [started_at, ended_at] window is considered "belonging" to that run. This is the
  // simplest approach (no schema migration, no ingest change) given that comm_message has no
  // run_id FK. The approximation is correct in practice: p0 comms during a run's lifetime
  // are the ones that matter for the RunsPage filter chip.
  const result = await env.DASHBOARD_DB
    .prepare(
      "SELECT pd.run_id, pd.pipeline_type, pd.status, pd.started_at, pd.ended_at, pd.payload," +
      " CASE WHEN EXISTS(" +
      "   SELECT 1 FROM comm_message cm WHERE cm.priority='p0'" +
      "   AND cm.ts >= pd.started_at" +
      "   AND cm.ts <= COALESCE(pd.ended_at, 9999999999999)" +
      " ) THEN 1 ELSE 0 END AS has_p0" +
      " FROM pipeline_detail pd ORDER BY pd.updated_at DESC LIMIT 100"
    )
    .all<{ run_id: string; pipeline_type: string; status: string; started_at: number; ended_at: number | null; payload: string; has_p0: number }>();

  const runs = result.results.map((row) => {
    let task = "";
    try {
      const p = JSON.parse(row.payload);
      task = p.summary?.task ?? "";
    } catch { /* ignore */ }
    return {
      run_id: row.run_id,
      pipeline: row.pipeline_type ?? "unknown",
      status: row.status,
      started_at: new Date(row.started_at).toISOString(),
      ended_at: row.ended_at ? new Date(row.ended_at).toISOString() : null,
      task,
      has_p0: row.has_p0 === 1,
    };
  });

  return json({ runs });
}

// ---------------------------------------------------------------------------
// READ — GET /memory
// ---------------------------------------------------------------------------

export async function handleGetMemory(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const result = await env.DASHBOARD_DB
    .prepare("SELECT path, content_hash, updated_at, parsed_json FROM memory_file ORDER BY updated_at DESC")
    .all<{ path: string; content_hash: string; updated_at: number; parsed_json: string | null }>();

  return json({ files: result.results });
}

// ---------------------------------------------------------------------------
// READ — GET /memory/agents/:name
// ---------------------------------------------------------------------------

export async function handleGetMemoryAgent(request: Request, env: V3Env, name: string): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const path = `agents/${name}.md`;
  const row = await env.DASHBOARD_DB
    .prepare("SELECT path, payload, parsed_json, content_hash, updated_at FROM memory_file WHERE path=?")
    .bind(path)
    .first<{ path: string; payload: string; parsed_json: string | null; content_hash: string; updated_at: number }>();

  if (!row) return json({ error: "not found" }, 404);
  return json(row);
}

// ---------------------------------------------------------------------------
// READ — GET /memory/root?path=MEMORY.md
// Returns a single root-level memory file (not under agents/) by path.
// Decision (L1): use query param rather than path segment to avoid URL
// encoding issues with filenames and to stay symmetric with the agents/:name
// style (both resolve to a single file row and return the same shape).
// ---------------------------------------------------------------------------

// Validate that a path is a safe root-level memory file path:
//   - non-empty, ≤100 chars
//   - no directory traversal (..)
//   - no absolute path (leading /)
//   - no path separators (root-level files only)
function validateMemoryRootPath(path: string): { ok: true } | { ok: false; reason: string } {
  if (!path || path.length > 100) return { ok: false, reason: "invalid path" };
  if (path.includes("..")) return { ok: false, reason: "path traversal not allowed" };
  if (path.startsWith("/")) return { ok: false, reason: "absolute paths not allowed" };
  if (path.includes("/") || path.includes("\\")) return { ok: false, reason: "subdirectory paths not allowed" };
  return { ok: true };
}

export async function handleGetMemoryRoot(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const pathParam = url.searchParams.get("path") ?? "";
  const validation = validateMemoryRootPath(pathParam);
  if (!validation.ok) return json({ error: validation.reason }, 400);

  const row = await env.DASHBOARD_DB
    .prepare("SELECT path, payload, content_hash, updated_at FROM memory_file WHERE path=?")
    .bind(pathParam)
    .first<{ path: string; payload: string; content_hash: string; updated_at: number }>();

  if (!row) return json({ error: "not found" }, 404);
  return json(row);
}

// ---------------------------------------------------------------------------
// READ — GET /decisions
// ---------------------------------------------------------------------------

export async function handleGetDecisions(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const result = await env.DASHBOARD_DB
    .prepare(
      "SELECT pk, run_id, decision_id, gate, agent, critic_verdict, updated_at, payload FROM decision_entry" +
      " ORDER BY updated_at DESC LIMIT 500"
    )
    .all<{ pk: string; run_id: string; decision_id: string; gate: string | null; agent: string | null; critic_verdict: string | null; updated_at: number; payload: string }>();

  const decisions = result.results.map((row) => {
    let title: string | null = null;
    try {
      const p = JSON.parse(row.payload);
      title = p.title ?? null;
    } catch { /* ignore */ }
    return { ...row, title };
  });

  return json({ decisions });
}

// ---------------------------------------------------------------------------
// READ — GET /decisions/:run_id
// ---------------------------------------------------------------------------

export async function handleGetDecisionsByRun(request: Request, env: V3Env, run_id: string): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const result = await env.DASHBOARD_DB
    .prepare("SELECT pk, run_id, decision_id, gate, agent, critic_verdict, payload, updated_at FROM decision_entry WHERE run_id=? ORDER BY decision_id ASC")
    .bind(run_id)
    .all<{ pk: string; run_id: string; decision_id: string; gate: string | null; agent: string | null; critic_verdict: string | null; payload: string; updated_at: number }>();

  if (result.results.length === 0) return json({ error: "not found" }, 404);
  return json({ run_id, decisions: result.results });
}

// ---------------------------------------------------------------------------
// READ — GET /decisions/:run_id/:did
// ---------------------------------------------------------------------------

export async function handleGetDecisionEntry(request: Request, env: V3Env, run_id: string, did: string): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const pk = `${run_id}:${did}`;
  const row = await env.DASHBOARD_DB
    .prepare("SELECT pk, run_id, decision_id, gate, agent, critic_verdict, payload, updated_at FROM decision_entry WHERE pk=?")
    .bind(pk)
    .first<{ pk: string; run_id: string; decision_id: string; gate: string | null; agent: string | null; critic_verdict: string | null; payload: string; updated_at: number }>();

  if (!row) return json({ error: "not found" }, 404);
  return json(row);
}

// ---------------------------------------------------------------------------
// READ — GET /comms
// ---------------------------------------------------------------------------

export async function handleGetComms(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const result = await env.DASHBOARD_DB
    .prepare(
      "SELECT filename, from_agent, to_agent, subject, priority, thread_id, ts, archived" +
      " FROM comm_message WHERE ts >= ? ORDER BY ts DESC LIMIT 500"
    )
    .bind(cutoff)
    .all<{ filename: string; from_agent: string; to_agent: string; subject: string | null; priority: string; thread_id: string | null; ts: number; archived: number }>();

  return json({ messages: result.results });
}

// ---------------------------------------------------------------------------
// READ — GET /comms/threads
// ---------------------------------------------------------------------------

export async function handleGetCommsThreads(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const result = await env.DASHBOARD_DB
    .prepare("SELECT thread_id, subject, participants_csv, status, started_at, last_ts, message_count FROM comm_thread ORDER BY last_ts DESC LIMIT 200")
    .all<{ thread_id: string; subject: string | null; participants_csv: string; status: string; started_at: number; last_ts: number; message_count: number }>();

  return json({ threads: result.results });
}

// ---------------------------------------------------------------------------
// READ — GET /comms/thread/:thread_id
// ---------------------------------------------------------------------------

export async function handleGetCommsThread(request: Request, env: V3Env, thread_id: string): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const meta = await env.DASHBOARD_DB
    .prepare("SELECT thread_id, subject, participants_csv, status, started_at, last_ts, message_count FROM comm_thread WHERE thread_id=?")
    .bind(thread_id)
    .first<{ thread_id: string; subject: string | null; participants_csv: string; status: string; started_at: number; last_ts: number; message_count: number }>();

  if (!meta) return json({ error: "not found" }, 404);

  const messages = await env.DASHBOARD_DB
    .prepare("SELECT filename, from_agent, to_agent, subject, priority, payload, ts FROM comm_message WHERE thread_id=? ORDER BY ts ASC")
    .bind(thread_id)
    .all<{ filename: string; from_agent: string; to_agent: string; subject: string | null; priority: string; payload: string; ts: number }>();

  return json({ ...meta, messages: messages.results });
}

// ---------------------------------------------------------------------------
// READ — GET /brainstorms
// ---------------------------------------------------------------------------

export async function handleGetBrainstorms(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const result = await env.DASHBOARD_DB
    .prepare("SELECT session_id, started_at, last_ts, turn_count, outcome, total_chunks FROM brainstorm_session ORDER BY last_ts DESC LIMIT 100")
    .all<{ session_id: string; started_at: number; last_ts: number; turn_count: number; outcome: string | null; total_chunks: number }>();

  return json({ sessions: result.results });
}

// ---------------------------------------------------------------------------
// READ — GET /brainstorms/:session_id
// ---------------------------------------------------------------------------

export async function handleGetBrainstormSession(request: Request, env: V3Env, session_id: string): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const meta = await env.DASHBOARD_DB
    .prepare("SELECT session_id, started_at, last_ts, turn_count, outcome, total_chunks FROM brainstorm_session WHERE session_id=?")
    .bind(session_id)
    .first<{ session_id: string; started_at: number; last_ts: number; turn_count: number; outcome: string | null; total_chunks: number }>();

  if (!meta) return json({ error: "not found" }, 404);

  // Re-stitch chunks in order
  const chunks = await env.DASHBOARD_DB
    .prepare("SELECT payload FROM brainstorm_session_chunk WHERE session_id=? ORDER BY chunk_idx ASC")
    .bind(session_id)
    .all<{ payload: string }>();

  // Merge all turns from all chunks
  const allTurns: unknown[] = [];
  for (const chunk of chunks.results) {
    try {
      const parsed = JSON.parse(chunk.payload);
      if (Array.isArray(parsed.turns)) {
        allTurns.push(...parsed.turns);
      }
    } catch { /* skip malformed chunk */ }
  }

  return json({ ...meta, turns: allTurns });
}

// ---------------------------------------------------------------------------
// READ — GET /projects/:name/health  (SSRF-guarded proxy)
// ---------------------------------------------------------------------------

export async function handleGetProjectHealth(
  request: Request,
  env: V3Env,
  name: string,
  cacheStorage: Cache | null,
  cors: Record<string, string> = {}
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  // Cache check (60 s TTL) — key on project name
  const cacheKey = `https://health-cache.internal/${encodeURIComponent(name)}`;
  if (cacheStorage) {
    const cached = await cacheStorage.match(cacheKey);
    if (cached) return cached;
  }

  // Look up deploy_url from the snapshot (defense-in-depth registry check)
  const snapshotRow = await env.DASHBOARD_DB
    .prepare("SELECT payload FROM snapshot WHERE id=1")
    .first<{ payload: string }>();

  let deployUrl: string | null = null;
  if (snapshotRow?.payload) {
    try {
      const envelope = JSON.parse(snapshotRow.payload);
      const projects: Array<{ name: string; deploy_url: string | null }> =
        (envelope.snapshot?.projects ?? envelope.projects ?? []);
      const proj = projects.find((p) => p.name === name);
      deployUrl = proj?.deploy_url ?? null;
    } catch { /* ignore */ }
  }

  // Also check memory_file for MEMORY.md (fallback: projects.json direct lookup)
  // Deploy URL validator — scheme + IP + private hostname
  const targetResult = buildHealthTarget(deployUrl);
  if (!targetResult.ok) {
    return json({ ok: false, reason: targetResult.reason, source_status: 0, age_s: null }, 502);
  }

  const result = await fetchHealth(targetResult.target);
  const responseBody = JSON.stringify(result);
  const response = new Response(responseBody, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
      ...cors,
    },
  });

  // Store in Cache API for 60 s — ACAO must be in headers before put() so
  // cached hits are served with the correct cross-origin headers.
  if (cacheStorage) {
    await cacheStorage.put(cacheKey, response.clone());
  }

  return response;
}

// ---------------------------------------------------------------------------
// READ — GET /search?q=&types=&limit=
// ---------------------------------------------------------------------------

// Type column values used in search_index match schema enum values
const TYPE_ALIASES: Record<string, string> = {
  runs: "run",
  memory: "memory",
  decisions: "decision",
  comms: "comm",
  threads: "thread",
  brainstorms: "brainstorm",
  projects: "project",
};

export async function handleSearch(request: Request, env: V3Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const queryResult = SearchQuerySchema.safeParse({
    q: url.searchParams.get("q") ?? "",
    types: url.searchParams.get("types") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!queryResult.success) return json({ error: "invalid query parameters" }, 400);

  const { q, types, limit } = queryResult.data;

  // Sanitize FTS5 query: wrap in quotes to escape special chars, then append *
  const ftsQuery = `"${q.replace(/"/g, '""')}"*`;

  // Determine which types to query
  const requestedTypes = types
    ? types.split(",").map((t) => t.trim()).filter((t) => t in TYPE_ALIASES)
    : Object.keys(TYPE_ALIASES);

  const hits: Array<{
    type: string;
    ref_id: string;
    permalink: string;
    title: string;
    snippet: string;
    rank: number;
  }> = [];

  // Run one FTS5 query per type (ranked; snippet generation)
  // D1 doesn't support bm25() in batch easily; run in parallel
  const typeQueries = requestedTypes.map(async (alias) => {
    const dbType = TYPE_ALIASES[alias];
    if (!dbType) return;
    try {
      const result = await env.DASHBOARD_DB
        .prepare(
          "SELECT type, ref_id, permalink, title," +
          " snippet(search_index, 4, '<mark>', '</mark>', '…', 32) AS snippet," +
          " -bm25(search_index) AS rank" +
          " FROM search_index WHERE search_index MATCH ? AND type=?" +
          " ORDER BY rank DESC LIMIT ?"
        )
        .bind(ftsQuery, dbType, limit)
        .all<{ type: string; ref_id: string; permalink: string; title: string; snippet: string; rank: number }>();
      hits.push(...result.results);
    } catch {
      // FTS5 query errors (e.g. syntax) — skip this type silently
    }
  });

  await Promise.all(typeQueries);

  // Sort all hits by rank descending (across types)
  hits.sort((a, b) => b.rank - a.rank);

  return json({ q, hits });
}
