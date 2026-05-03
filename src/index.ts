/**
 * factory-dashboard-api — Cloudflare Worker (Module syntax)
 *
 * Routes:
 *   POST /ingest                  — bearer auth; validates + stores live snapshot in D1
 *   POST /ingest/profiles         — bearer auth; upserts agent_profile rows (≤350 KB)
 *   POST /ingest/pipeline/:run_id — bearer auth; upserts pipeline_detail row (≤50 KB)
 *   GET  /snapshot                — CF Access JWT auth; returns live snapshot + meta
 *   GET  /agents/profiles         — CF Access JWT auth; returns all agent profiles
 *   GET  /pipelines/:run_id       — CF Access JWT auth; returns one pipeline detail row
 *   GET  /healthz                 — public; returns liveness info
 */

import { validateBearer } from "./auth-bearer";
import { validateCfAccessJwt } from "./auth-cf-access";
import {
  SnapshotV1Schema,
  AgentProfilesIngestSchema,
  PipelineDetailIngestSchema,
} from "./snapshot-schema";
import {
  handleIngestMemory,
  handleIngestDecisions,
  handleIngestComms,
  handleIngestBrainstorms,
  handleGetRuns,
  handleGetMemory,
  handleGetMemoryAgent,
  handleGetMemoryRoot,
  handleGetDecisions,
  handleGetDecisionsByRun,
  handleGetDecisionEntry,
  handleGetComms,
  handleGetCommsThreads,
  handleGetCommsThread,
  handleGetBrainstorms,
  handleGetBrainstormSession,
  handleGetProjectHealth,
  handleSearch,
} from "./v3-routes";
import {
  handleGetPipelineSummary,
  handleGetOutputFile,
  handleGetConveyor,
  handleGetAgentAvatars,
  handleGetMemoryEntries,
  handleGetCommsFeed,
  handleGetTaskTree,
  handleIngestIntakeDecisions,
  handleIngestMemoryEntries,
  handleIngestRunBeats,
  handleIngestTaskTree,
  handleIngestOutputFiles,
} from "./v4-routes";
import { handleMobileRoutes } from "./mobile-routes";

export interface Env {
  DASHBOARD_DB: D1Database;
  FACTORY_DASHBOARD: KVNamespace; // retained one cycle for rollback — unused
  INGEST_TOKEN: string;
  CF_ACCESS_AUD_SNAPSHOT: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  // Mobile auth + push (set via: wrangler secret put <NAME>)
  MOBILE_JWT_SIGNING_KEY: string;  // base64-encoded 32-byte fallback HS256 signing key
  MOBILE_PUSH_SECRET: string;      // bearer token for /mobile/push/dispatch (daemon hook)
  APPLE_CLIENT_ID: string;         // Apple Services ID (aud for Apple identity tokens)
  GOOGLE_CLIENT_ID: string;        // Google OAuth client ID
  MOBILE_INTAKE_QUEUE: Queue;      // CF Queue producer — binding: MOBILE_INTAKE_QUEUE
}

// Per-route body size limits (replace the old global MAX_BODY_BYTES = 256 KB).
const BODY_LIMIT_SNAPSHOT = 256 * 1024;  // 256 KB — live snapshot cap
const BODY_LIMIT_PROFILES = 350 * 1024;  // 350 KB — profile bundle (300 KB + envelope)
const BODY_LIMIT_PIPELINE = 50 * 1024;   // 50 KB  — pipeline detail (worst-case ~30 KB)

const ALLOWED_EMAIL = "sai19872000@gmail.com";

// CORS allowlist for browser-initiated reads from the SPA.
// Two origins are required:
//   - prod apex (post Phase C apex flip)
//   - CF Pages staging-branch URL (legacy direct .pages.dev access)
// Browser preflight + 200 paths echo the request Origin only when it is in
// this set. Origin is NOT echoed on the 401 return path — see qa_lead Common
// P0 row "JWT-before-CORS leaks CORS".
const ALLOWED_ORIGINS = new Set<string>([
  "https://dashboard.saiteja.ai",
  "https://staging.dashboard-saiteja.pages.dev",
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
}

// Inject ACAO headers into an existing Response. Used for v3 GET responses
// whose handlers cannot call corsHeaders() directly (avoids circular import).
function addCors(response: Response, request: Request): Response {
  const cors = corsHeaders(request);
  if (Object.keys(cors).length === 0) return response;
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}

interface SnapshotMeta {
  last_push_at: string;
  daemon_id: string;
  push_count: number;
}

interface SnapshotEnvelope {
  snapshot: unknown;
  meta: SnapshotMeta;
}

// Compute SHA-256 hex digest of a string.
async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Read and enforce a per-route body size limit.
// Returns { ok: true, buffer, rawBody } or { ok: false, response }.
async function readBody(
  request: Request,
  limitBytes: number,
  limitLabel: string
): Promise<
  | { ok: true; buffer: ArrayBuffer; rawBody: string }
  | { ok: false; response: Response }
> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && parseInt(contentLength, 10) > limitBytes) {
    return { ok: false, response: json({ error: `body exceeds ${limitLabel}` }, 413) };
  }
  let buffer: ArrayBuffer;
  let rawBody: string;
  try {
    buffer = await request.arrayBuffer();
    if (buffer.byteLength > limitBytes) {
      return { ok: false, response: json({ error: `body exceeds ${limitLabel}` }, 413) };
    }
    rawBody = new TextDecoder().decode(buffer);
  } catch {
    return { ok: false, response: json({ error: "failed to read body" }, 400) };
  }
  return { ok: true, buffer, rawBody };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — handle before auth so browsers can probe without a JWT.
    // Only respond to OPTIONS for routes the SPA calls (GET routes); reflect Origin
    // only when allowlisted. Ingest paths are daemon-only and do not need preflight.
    if (request.method === "OPTIONS") {
      const isCorsGet =
        path === "/snapshot" ||
        path === "/healthz" ||
        path === "/agents/profiles" ||
        path.startsWith("/pipelines/") ||
        // v3 read routes
        path === "/runs" ||
        path === "/memory" ||
        path === "/memory/root" ||
        path.startsWith("/memory/") ||
        path === "/decisions" ||
        path.startsWith("/decisions/") ||
        path === "/comms" ||
        path === "/comms/threads" ||
        path.startsWith("/comms/thread/") ||
        path === "/brainstorms" ||
        path.startsWith("/brainstorms/") ||
        path.startsWith("/projects/") ||
        path === "/search" ||
        // v4 read routes
        path.startsWith("/pipeline/") ||
        path.startsWith("/outputs/") ||
        path === "/now/conveyor" ||
        path === "/agents/avatars" ||
        path === "/memory/entries" ||
        path === "/comms/feed" ||
        path.startsWith("/runs/");
      if (isCorsGet) {
        const headers: Record<string, string> = {
          ...corsHeaders(request),
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        };
        return new Response(null, { status: 204, headers });
      }
    }

    // Mobile OPTIONS: native app doesn't need CORS preflight, but respond with
    // 204 so dev proxies (Expo debug builds) don't hang on OPTIONS.
    if (request.method === "OPTIONS" && path.startsWith("/mobile/")) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age":       "600",
        },
      });
    }

    // ── Ingest routes (bearer auth) ────────────────────────────────────────
    if (request.method === "POST" && path === "/ingest") {
      return handleIngest(request, env);
    }

    if (request.method === "POST" && path === "/ingest/profiles") {
      return handleIngestProfiles(request, env);
    }

    if (request.method === "POST" && path.startsWith("/ingest/pipeline/")) {
      const run_id = path.slice("/ingest/pipeline/".length);
      if (!run_id) return json({ error: "run_id required" }, 400);
      return handleIngestPipeline(request, env, run_id);
    }

    // ── Read routes (CF Access JWT) ────────────────────────────────────────
    if (request.method === "GET" && path === "/snapshot") {
      return handleSnapshot(request, env);
    }

    if (request.method === "GET" && path === "/agents/profiles") {
      return handleAgentProfiles(request, env);
    }

    if (request.method === "GET" && path.startsWith("/pipelines/")) {
      const run_id = path.slice("/pipelines/".length);
      if (!run_id) return json({ error: "run_id required" }, 400);
      return handlePipelineDetail(request, env, run_id);
    }

    if (request.method === "GET" && path === "/healthz") {
      return handleHealthz(request, env);
    }

    // ── v3 Ingest routes (bearer auth) ────────────────────────────────────
    if (request.method === "POST" && path === "/ingest/memory") {
      return handleIngestMemory(request, env);
    }
    if (request.method === "POST" && path === "/ingest/decisions") {
      return handleIngestDecisions(request, env);
    }
    if (request.method === "POST" && path === "/ingest/comms") {
      return handleIngestComms(request, env);
    }
    if (request.method === "POST" && path === "/ingest/brainstorms") {
      return handleIngestBrainstorms(request, env);
    }

    // ── v3 Read routes (CF Access JWT) ────────────────────────────────────
    if (request.method === "GET" && path === "/runs") {
      return addCors(await handleGetRuns(request, env), request);
    }
    if (request.method === "GET" && path === "/memory") {
      return addCors(await handleGetMemory(request, env), request);
    }
    if (request.method === "GET" && path === "/memory/root") {
      return addCors(await handleGetMemoryRoot(request, env), request);
    }
    if (request.method === "GET" && path.startsWith("/memory/agents/")) {
      const name = path.slice("/memory/agents/".length);
      if (!name) return json({ error: "agent name required" }, 400);
      return addCors(await handleGetMemoryAgent(request, env, name), request);
    }
    if (request.method === "GET" && path === "/decisions") {
      return addCors(await handleGetDecisions(request, env), request);
    }
    if (request.method === "GET" && path.startsWith("/decisions/")) {
      const rest = path.slice("/decisions/".length); // "run_id" or "run_id/D-N"
      const slash = rest.indexOf("/");
      if (slash === -1) {
        return addCors(await handleGetDecisionsByRun(request, env, rest), request);
      } else {
        const run_id = rest.slice(0, slash);
        const did = rest.slice(slash + 1);
        return addCors(await handleGetDecisionEntry(request, env, run_id, did), request);
      }
    }
    if (request.method === "GET" && path === "/comms") {
      return addCors(await handleGetComms(request, env), request);
    }
    if (request.method === "GET" && path === "/comms/threads") {
      return addCors(await handleGetCommsThreads(request, env), request);
    }
    if (request.method === "GET" && path.startsWith("/comms/thread/")) {
      const thread_id = path.slice("/comms/thread/".length);
      if (!thread_id) return json({ error: "thread_id required" }, 400);
      return addCors(await handleGetCommsThread(request, env, thread_id), request);
    }
    if (request.method === "GET" && path === "/brainstorms") {
      return addCors(await handleGetBrainstorms(request, env), request);
    }
    if (request.method === "GET" && path.startsWith("/brainstorms/")) {
      const session_id = path.slice("/brainstorms/".length);
      if (!session_id) return json({ error: "session_id required" }, 400);
      return addCors(await handleGetBrainstormSession(request, env, session_id), request);
    }
    if (request.method === "GET" && path.startsWith("/projects/") && path.endsWith("/health")) {
      const name = path.slice("/projects/".length, -"/health".length);
      if (!name) return json({ error: "project name required" }, 400);
      const cacheStorage = caches.default ?? null;
      return addCors(await handleGetProjectHealth(request, env, name, cacheStorage, corsHeaders(request)), request);
    }
    if (request.method === "GET" && path === "/search") {
      return addCors(await handleSearch(request, env), request);
    }

    // ── v4 Ingest routes (bearer auth) ────────────────────────────────────
    if (request.method === "POST" && path === "/ingest/v4/intake-decisions") {
      return handleIngestIntakeDecisions(request, env);
    }
    if (request.method === "POST" && path === "/ingest/v4/memory-entries") {
      return handleIngestMemoryEntries(request, env);
    }
    if (request.method === "POST" && path === "/ingest/v4/run-beats") {
      return handleIngestRunBeats(request, env);
    }
    if (request.method === "POST" && path.startsWith("/ingest/v4/task-tree/")) {
      const task_run_id = path.slice("/ingest/v4/task-tree/".length);
      if (!task_run_id) return json({ error: "run_id required" }, 400);
      return handleIngestTaskTree(request, env, task_run_id);
    }
    if (request.method === "POST" && path.startsWith("/ingest/v4/outputs/")) {
      const out_run_id = path.slice("/ingest/v4/outputs/".length);
      if (!out_run_id) return json({ error: "run_id required" }, 400);
      return handleIngestOutputFiles(request, env, out_run_id);
    }

    // ── v4 Read routes (CF Access JWT) ────────────────────────────────────
    if (request.method === "GET" && path.startsWith("/pipeline/") && path.endsWith("/summary")) {
      const mid = path.slice("/pipeline/".length, -"/summary".length);
      if (!mid) return json({ error: "run_id required" }, 400);
      return addCors(await handleGetPipelineSummary(request, env, mid), request);
    }
    if (request.method === "GET" && path.startsWith("/outputs/")) {
      const rest = path.slice("/outputs/".length);          // "<run_id>/<filename>"
      const slash = rest.indexOf("/");
      if (slash === -1) return json({ error: "filename required" }, 400);
      const out_run_id = rest.slice(0, slash);
      const filename   = rest.slice(slash + 1);
      return addCors(await handleGetOutputFile(request, env, out_run_id, filename), request);
    }
    if (request.method === "GET" && path === "/now/conveyor") {
      return addCors(await handleGetConveyor(request, env), request);
    }
    if (request.method === "GET" && path === "/agents/avatars") {
      return addCors(await handleGetAgentAvatars(request, env), request);
    }
    if (request.method === "GET" && path === "/memory/entries") {
      return addCors(await handleGetMemoryEntries(request, env), request);
    }
    if (request.method === "GET" && path === "/comms/feed") {
      return addCors(await handleGetCommsFeed(request, env), request);
    }
    if (request.method === "GET" && path.startsWith("/runs/") && path.endsWith("/task-tree")) {
      const tt_run_id = path.slice("/runs/".length, -"/task-tree".length);
      if (!tt_run_id) return json({ error: "run_id required" }, 400);
      return addCors(await handleGetTaskTree(request, env, tt_run_id), request);
    }

    // ── /mobile/* routes (mobile JWT auth — separate from CF-Access) ─────────
    // These routes are intentionally NOT wrapped in CF-Access middleware.
    // Mobile app uses its own HS256 JWT issued by /mobile/auth/apple|google.
    if (path.startsWith("/mobile/")) {
      const mobileResp = await handleMobileRoutes(request, path, env);
      if (mobileResp !== null) return mobileResp;
    }

    return json({ error: "not found" }, 404);
  },
};

// ---------------------------------------------------------------------------
// POST /ingest  — live snapshot (Surface A)
// ---------------------------------------------------------------------------

async function handleIngest(request: Request, env: Env): Promise<Response> {
  // 1. Bearer auth — never log the token
  const bearerResult = validateBearer(request, env.INGEST_TOKEN);
  if (!bearerResult.ok) {
    return new Response(null, { status: 401 });
  }

  // 2. Content-Type check
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  // 3. Snapshot version header — accept v1 or v2 during rollover window (§10)
  const versionHeader = request.headers.get("X-Snapshot-Version");
  if (versionHeader !== "1" && versionHeader !== "2") {
    return json({ error: "unknown snapshot version" }, 400);
  }

  // 4. Body size guard (256 KB)
  const bodyResult = await readBody(request, BODY_LIMIT_SNAPSHOT, "256 KB");
  if (!bodyResult.ok) return bodyResult.response;
  const { buffer, rawBody } = bodyResult;

  // 5. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  // 6. Schema validation (includes version 1|2 check via union)
  const schemaResult = SnapshotV1Schema.safeParse(parsed);
  if (!schemaResult.success) {
    const versionError = schemaResult.error.issues.find(
      (i) => i.path[0] === "version"
    );
    if (versionError) {
      return json({ error: "unknown snapshot version" }, 400);
    }
    return json({ error: "invalid snapshot schema" }, 400);
  }

  const snapshot = schemaResult.data;

  // 7. SHA-256 content hash (observability; not used for control flow here)
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const contentHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // 8. Read existing push_count from D1 (read-modify-write).
  const existingRow = await env.DASHBOARD_DB
    .prepare("SELECT payload FROM snapshot WHERE id=1")
    .first<{ payload: string }>();
  const prevPushCount = existingRow
    ? ((JSON.parse(existingRow.payload) as SnapshotEnvelope).meta?.push_count ?? 0)
    : 0;

  // 9. Build envelope and UPSERT into D1.
  const meta: SnapshotMeta = {
    last_push_at: new Date().toISOString(),
    daemon_id: snapshot.daemon_id,
    push_count: prevPushCount + 1,
  };
  const envelope: SnapshotEnvelope = { snapshot: parsed, meta };

  try {
    await env.DASHBOARD_DB
      .prepare(
        "INSERT INTO snapshot (id, payload, content_hash, updated_at) VALUES (1, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, content_hash=excluded.content_hash, updated_at=excluded.updated_at"
      )
      .bind(JSON.stringify(envelope), contentHash, Date.now())
      .run();
  } catch {
    return json({ error: "storage write failed" }, 500);
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// POST /ingest/profiles  — agent profiles bundle (Surface B)
// ---------------------------------------------------------------------------

async function handleIngestProfiles(request: Request, env: Env): Promise<Response> {
  const bearerResult = validateBearer(request, env.INGEST_TOKEN);
  if (!bearerResult.ok) return new Response(null, { status: 401 });

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  const bodyResult = await readBody(request, BODY_LIMIT_PROFILES, "350 KB");
  if (!bodyResult.ok) return bodyResult.response;
  const { rawBody } = bodyResult;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schemaResult = AgentProfilesIngestSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return json({ error: "invalid agent profiles schema" }, 400);
  }

  const { agents } = schemaResult.data;
  const now = Date.now();

  // UPSERT each agent row. SHA-256 per-row hash check: skip write when hash unchanged.
  // Uses ON CONFLICT ... DO UPDATE ... WHERE to avoid redundant writes in D1.
  const stmts = await Promise.all(
    Object.entries(agents).map(async ([agent_id, profile]) => {
      const payloadStr = JSON.stringify(profile);
      const contentHash = await sha256Hex(payloadStr);
      return env.DASHBOARD_DB
        .prepare(
          "INSERT INTO agent_profile (agent_id, payload, content_hash, updated_at) " +
          "VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(agent_id) DO UPDATE SET " +
          "  payload = excluded.payload, " +
          "  content_hash = excluded.content_hash, " +
          "  updated_at = excluded.updated_at " +
          "WHERE excluded.content_hash != agent_profile.content_hash"
        )
        .bind(agent_id, payloadStr, contentHash, now);
    })
  );

  if (stmts.length === 0) {
    return new Response(null, { status: 204 });
  }

  try {
    await env.DASHBOARD_DB.batch(stmts);
  } catch {
    return json({ error: "storage write failed" }, 500);
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// POST /ingest/pipeline/:run_id  — pipeline detail (Surface C)
// ---------------------------------------------------------------------------

async function handleIngestPipeline(
  request: Request,
  env: Env,
  run_id: string
): Promise<Response> {
  const bearerResult = validateBearer(request, env.INGEST_TOKEN);
  if (!bearerResult.ok) return new Response(null, { status: 401 });

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415);
  }

  const bodyResult = await readBody(request, BODY_LIMIT_PIPELINE, "50 KB");
  if (!bodyResult.ok) return bodyResult.response;
  const { rawBody } = bodyResult;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schemaResult = PipelineDetailIngestSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return json({ error: "invalid pipeline detail schema" }, 400);
  }

  const detail = schemaResult.data;

  // run_id in URL must match body
  if (detail.run_id !== run_id) {
    return json({ error: "run_id mismatch" }, 400);
  }

  const payloadStr = rawBody;
  const contentHash = await sha256Hex(payloadStr);
  const now = Date.now();
  const startedAtMs = new Date(detail.started_at).getTime();
  const endedAtMs = detail.ended_at ? new Date(detail.ended_at).getTime() : null;

  try {
    // UPSERT the pipeline_detail row.
    await env.DASHBOARD_DB
      .prepare(
        "INSERT INTO pipeline_detail " +
        "  (run_id, pipeline_type, status, payload, content_hash, started_at, ended_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(run_id) DO UPDATE SET " +
        "  pipeline_type = excluded.pipeline_type, " +
        "  status        = excluded.status, " +
        "  payload       = excluded.payload, " +
        "  content_hash  = excluded.content_hash, " +
        "  started_at    = excluded.started_at, " +
        "  ended_at      = excluded.ended_at, " +
        "  updated_at    = excluded.updated_at"
      )
      .bind(run_id, detail.pipeline_type, detail.status, payloadStr, contentHash, startedAtMs, endedAtMs, now)
      .run();

    // Eviction: retain only the 50 most recent pipeline_detail rows (by updated_at DESC).
    // D1 rows are small; this DELETE is O(50). Single statement, no transaction needed.
    await env.DASHBOARD_DB
      .prepare(
        "DELETE FROM pipeline_detail WHERE run_id NOT IN " +
        "  (SELECT run_id FROM pipeline_detail ORDER BY updated_at DESC LIMIT 50)"
      )
      .run();
  } catch {
    return json({ error: "storage write failed" }, 500);
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// GET /snapshot  — live snapshot (Surface A)
// ---------------------------------------------------------------------------

async function handleSnapshot(request: Request, env: Env): Promise<Response> {
  const authResult = await validateCfAccessJwt(
    request,
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD_SNAPSHOT,
    ALLOWED_EMAIL
  );
  if (!authResult.ok) {
    return new Response(null, { status: authResult.status });
  }

  const row = await env.DASHBOARD_DB
    .prepare("SELECT payload FROM snapshot WHERE id=1")
    .first<{ payload: string }>();

  if (!row || !row.payload) {
    return json({ error: "snapshot not found", asleep: true }, 404);
  }

  let envelope: SnapshotEnvelope;
  try {
    envelope = JSON.parse(row.payload) as SnapshotEnvelope;
  } catch {
    return json({ error: "snapshot corrupted" }, 500);
  }

  const responseBody = {
    ...(envelope.snapshot as object),
    _meta: envelope.meta ?? null,
  };

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /agents/profiles  — agent profiles (Surface B)
// ---------------------------------------------------------------------------

async function handleAgentProfiles(request: Request, env: Env): Promise<Response> {
  const authResult = await validateCfAccessJwt(
    request,
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD_SNAPSHOT,
    ALLOWED_EMAIL
  );
  if (!authResult.ok) {
    return new Response(null, { status: authResult.status });
  }

  const result = await env.DASHBOARD_DB
    .prepare("SELECT agent_id, payload FROM agent_profile")
    .all<{ agent_id: string; payload: string }>();

  const agents: Record<string, unknown> = {};
  for (const row of result.results) {
    try {
      agents[row.agent_id] = JSON.parse(row.payload);
    } catch {
      // skip corrupted rows
    }
  }

  const responseBody = {
    version: 1,
    generated_at: new Date().toISOString(),
    agents,
  };

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /pipelines/:run_id  — pipeline detail (Surface C)
// ---------------------------------------------------------------------------

async function handlePipelineDetail(
  request: Request,
  env: Env,
  run_id: string
): Promise<Response> {
  const authResult = await validateCfAccessJwt(
    request,
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD_SNAPSHOT,
    ALLOWED_EMAIL
  );
  if (!authResult.ok) {
    return new Response(null, { status: authResult.status });
  }

  const row = await env.DASHBOARD_DB
    .prepare("SELECT payload FROM pipeline_detail WHERE run_id=?")
    .bind(run_id)
    .first<{ payload: string }>();

  if (!row || !row.payload) {
    return json({ error: "pipeline not found" }, 404);
  }

  // Return the stored payload as-is (daemon is the source of truth for shape)
  return new Response(row.payload, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(request),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /healthz
// ---------------------------------------------------------------------------

async function handleHealthz(request: Request, env: Env): Promise<Response> {
  const row = await env.DASHBOARD_DB
    .prepare("SELECT payload, updated_at FROM snapshot WHERE id=1")
    .first<{ payload: string; updated_at: number }>();

  const now = Date.now();
  let age_s: number | null = null;
  let meta: SnapshotMeta | null = null;

  if (row) {
    age_s = Math.floor((now - row.updated_at) / 1000);
    try {
      const envelope = JSON.parse(row.payload) as SnapshotEnvelope;
      meta = envelope.meta ?? null;
    } catch {
      // ignore parse failure — return nulls below
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      last_push_at: meta?.last_push_at ?? null,
      push_count: meta?.push_count ?? 0,
      age_s,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(request),
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
