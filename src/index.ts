/**
 * factory-dashboard-api — Cloudflare Worker (Module syntax)
 *
 * Routes:
 *   POST /ingest   — bearer auth; validates + stores snapshot in KV
 *   GET  /snapshot — CF Access JWT auth; returns snapshot + meta
 *   GET  /healthz  — public; returns liveness info
 */

import { validateBearer } from "./auth-bearer";
import { validateCfAccessJwt } from "./auth-cf-access";
import { SnapshotV1Schema } from "./snapshot-schema";

export interface Env {
  FACTORY_DASHBOARD: KVNamespace;
  INGEST_TOKEN: string;
  CF_ACCESS_AUD_SNAPSHOT: string;
  CF_ACCESS_TEAM_DOMAIN: string;
}

const MAX_BODY_BYTES = 256 * 1024; // 256 KB
const SNAPSHOT_KEY = "factory:snapshot:current";
const SNAPSHOT_TTL_S = 600;
const ALLOWED_EMAIL = "sai19872000@gmail.com";

// CORS allowlist for browser-initiated reads from the SPA.
// Both origins are required:
//   - prod apex (post Phase C apex flip)
//   - CF Pages staging-branch URL (Phase A audit)
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

interface SnapshotMeta {
  last_push_at: string;
  daemon_id: string;
  push_count: number;
}

interface SnapshotEnvelope {
  snapshot: unknown;
  meta: SnapshotMeta;
}

function secondsUntilNextUtcMidnight(): number {
  const now = new Date();
  const midnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  ));
  return Math.floor((midnight.getTime() - now.getTime()) / 1000);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight — handle before auth so browsers can probe without a JWT.
    // Only respond to OPTIONS for routes the SPA actually calls; reflect Origin
    // only when allowlisted (otherwise return 204 with no CORS headers, which
    // the browser treats as a failed preflight).
    if (request.method === "OPTIONS" && (path === "/snapshot" || path === "/healthz")) {
      const headers: Record<string, string> = {
        ...corsHeaders(request),
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      };
      return new Response(null, { status: 204, headers });
    }

    if (request.method === "POST" && path === "/ingest") {
      return handleIngest(request, env);
    }

    if (request.method === "GET" && path === "/snapshot") {
      return handleSnapshot(request, env);
    }

    if (request.method === "GET" && path === "/healthz") {
      return handleHealthz(request, env);
    }

    return json({ error: "not found" }, 404);
  },
};

// ---------------------------------------------------------------------------
// POST /ingest
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

  // 3. Snapshot version header
  const versionHeader = request.headers.get("X-Snapshot-Version");
  if (versionHeader !== "1") {
    return json({ error: "unknown snapshot version" }, 400);
  }

  // 4. Body size guard
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return json({ error: "body exceeds 256 KB" }, 413);
  }

  let rawBody: string;
  try {
    // Read and enforce hard size limit
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MAX_BODY_BYTES) {
      return json({ error: "body exceeds 256 KB" }, 413);
    }
    rawBody = new TextDecoder().decode(buffer);
  } catch {
    return json({ error: "failed to read body" }, 400);
  }

  // 5. JSON parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  // 6. Schema validation (includes version: 1 check via literal)
  const schemaResult = SnapshotV1Schema.safeParse(parsed);
  if (!schemaResult.success) {
    // Check if it's a version mismatch specifically
    const versionError = schemaResult.error.issues.find(
      (i) => i.path[0] === "version"
    );
    if (versionError) {
      return json({ error: "unknown snapshot version" }, 400);
    }
    return json({ error: "invalid snapshot schema" }, 400);
  }

  const snapshot = schemaResult.data;

  // 7. Build and store a single envelope (halves daily KV writes: 2 → 1).
  //    Read existing envelope first to carry forward push_count.
  const existingEnvelope = await env.FACTORY_DASHBOARD.get<SnapshotEnvelope>(
    SNAPSHOT_KEY,
    "json",
  );
  const pushCount = (existingEnvelope?.meta?.push_count ?? 0) + 1;
  const meta: SnapshotMeta = {
    last_push_at: new Date().toISOString(),
    daemon_id: snapshot.daemon_id,
    push_count: pushCount,
  };
  const envelope: SnapshotEnvelope = { snapshot: parsed, meta };

  try {
    await env.FACTORY_DASHBOARD.put(
      SNAPSHOT_KEY,
      JSON.stringify(envelope),
      { expirationTtl: SNAPSHOT_TTL_S },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("KV put() limit exceeded") || msg.includes("exceeded daily")) {
      const retryAfterS = secondsUntilNextUtcMidnight();
      console.warn(`[ingest] KV daily quota exhausted; retry_after_s=${retryAfterS}`);
      return new Response(
        JSON.stringify({ error: "kv quota exceeded", retry_after_s: retryAfterS }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfterS),
          },
        },
      );
    }
    throw err;
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// GET /snapshot
// ---------------------------------------------------------------------------

async function handleSnapshot(request: Request, env: Env): Promise<Response> {
  // Verify CF Access JWT — defense-in-depth even though edge already gated.
  // Do NOT trust X-Forwarded-* headers.
  const authResult = await validateCfAccessJwt(
    request,
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD_SNAPSHOT,
    ALLOWED_EMAIL
  );

  if (!authResult.ok) {
    return new Response(null, { status: authResult.status });
  }

  const rawEnvelope = await env.FACTORY_DASHBOARD.get(SNAPSHOT_KEY, "text");

  if (rawEnvelope === null) {
    // Envelope expired — factory is asleep
    return json({ error: "snapshot not found", asleep: true }, 404);
  }

  let envelope: SnapshotEnvelope;
  try {
    envelope = JSON.parse(rawEnvelope) as SnapshotEnvelope;
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
// GET /healthz
// ---------------------------------------------------------------------------

async function handleHealthz(request: Request, env: Env): Promise<Response> {
  const envelope = await env.FACTORY_DASHBOARD.get<SnapshotEnvelope>(SNAPSHOT_KEY, "json");
  const meta = envelope?.meta ?? null;

  const now = Date.now();
  let age_s: number | null = null;
  if (meta?.last_push_at) {
    const lastPush = new Date(meta.last_push_at).getTime();
    age_s = Math.floor((now - lastPush) / 1000);
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
