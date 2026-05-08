/**
 * mobile-routes.ts — /mobile/* route handlers for factory-dashboard-api Worker.
 *
 * Auth model:
 *   - /mobile/auth/*         → public (verifies platform identity token, no prior mobile JWT)
 *   - /mobile/push/dispatch  → bearer MOBILE_PUSH_SECRET (daemon-to-Worker call)
 *   - All other /mobile/*    → mobile JWT middleware (verifyAccessToken + allowlist check)
 *
 * Routes (14+):
 *   POST /mobile/auth/apple           verify Apple identity token → mint JWT pair
 *   POST /mobile/auth/google          verify Google identity token → mint JWT pair
 *   POST /mobile/auth/refresh         refresh-token grant → rotate access token
 *   POST /mobile/push/register        upsert Expo device token
 *   POST /mobile/push/unregister      soft-delete device row (sign-out)
 *   POST /mobile/push/dispatch        daemon hook — query devices or fire Expo Push
 *   GET  /mobile/runs                 list active + recent runs (last 50)
 *   GET  /mobile/runs/:run_id         full task tree + agent timeline
 *   GET  /mobile/comms                paginated comms feed
 *   GET  /mobile/comms/threads         list threads (paginated)
 *   GET  /mobile/comms/threads/:tid   full thread
 *   GET  /mobile/sessions             list sessions (active + archived)
 *   GET  /mobile/sessions/:sid        full session content
 *   POST /mobile/intake               enqueue message to CF Queue
 *   POST /mobile/intake/confirm       enqueue intent confirmation
 *   GET  /mobile/events               SSE stream (delegates to mobile-sse.ts)
 *   POST /mobile/voice/transcribe     STUB — 503 until Whisper key sourced
 */

import { mintTokenPair, consumeRefreshToken } from "./mobile-jwt";
import { verifyAppleIdentityToken, verifyGoogleIdentityToken } from "./mobile-jwks";
import { handleMobileSSE } from "./mobile-sse";
import { resolveMobileAuth } from "./auth-mode";
import type { MobileJwtContext } from "./auth-mode";
export type { MobileJwtContext };

// ---------------------------------------------------------------------------
// Env interface
// ---------------------------------------------------------------------------

export interface MobileEnv {
  DASHBOARD_DB: D1Database;
  MOBILE_JWT_SIGNING_KEY: string;  // base64-encoded 32-byte fallback signing key
  MOBILE_PUSH_SECRET: string;      // bearer secret for /mobile/push/dispatch
  APPLE_CLIENT_ID: string;         // Apple Services ID (aud for Apple identity tokens)
  GOOGLE_CLIENT_ID: string;        // Google OAuth client ID
  MOBILE_INTAKE_QUEUE: Queue;      // CF Queue producer binding
  MOBILE_AUTH_MODE?: string;       // "founder" | "oauth" (default "oauth" via fail-closed fallback)
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(code: string, message: string, status: number): Response {
  return json({ error: code, message }, status);
}

async function readBodyJson(
  request: Request,
  limitBytes = 64 * 1024
): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  const cl = request.headers.get("Content-Length");
  if (cl !== null && parseInt(cl, 10) > limitBytes) {
    return { ok: false, response: jsonError("body_too_large", "Request body too large", 413) };
  }
  let buf: ArrayBuffer;
  try {
    buf = await request.arrayBuffer();
  } catch {
    return { ok: false, response: jsonError("read_error", "Failed to read request body", 400) };
  }
  if (buf.byteLength > limitBytes) {
    return { ok: false, response: jsonError("body_too_large", "Request body too large", 413) };
  }
  try {
    const data = JSON.parse(new TextDecoder().decode(buf));
    return { ok: true, data };
  } catch {
    return { ok: false, response: jsonError("invalid_json", "Invalid JSON", 400) };
  }
}

// ---------------------------------------------------------------------------
// Bearer auth for push/dispatch
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aB = enc.encode(a);
  const bB = enc.encode(b);
  let diff = aB.length ^ bB.length;
  const len = Math.max(aB.length, bB.length);
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0);
  return diff === 0;
}

function requirePushSecret(request: Request, env: MobileEnv): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  return timingSafeEqual(auth.slice(7), env.MOBILE_PUSH_SECRET);
}

// ---------------------------------------------------------------------------
// D1 row types
// ---------------------------------------------------------------------------

interface DeviceRow {
  device_id:     string;
  expo_token:    string;
  platform:      string;
  sub_id:        string;
  auth_provider: string;
  push_prefs:    string;
  active:        number;
}

interface RunRow {
  run_id:        string;
  pipeline_type: string;
  status:        string;
  started_at:    number;
  ended_at:      number | null;
  payload:       string;
  updated_at:    number;
}

interface CommRow {
  filename:   string;
  from_agent: string;
  to_agent:   string;
  priority:   string;
  thread_id:  string | null;
  subject:    string | null;
  payload:    string;
  ts:         number;
}

interface SessionRow {
  session_id:  string;
  status:      string;
  started_at:  number;
  last_msg_at: number;
  msg_count:   number;
  title:       string | null;
}

interface SessionContentRow {
  session_id: string;
  payload:    string;
  updated_at: number;
}

interface BrainstormSessionRow {
  session_id:   string;
  started_at:   number;
  last_ts:      number;
  turn_count:   number;
  outcome:      string | null;
  total_chunks: number;
}

interface BrainstormChunkRow {
  session_id: string;
  chunk_idx:  number;
  payload:    string;
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/auth/apple
// ---------------------------------------------------------------------------

async function handleAuthApple(request: Request, env: MobileEnv): Promise<Response> {
  const bodyResult = await readBodyJson(request);
  if (!bodyResult.ok) return bodyResult.response;

  const body = bodyResult.data as Record<string, unknown>;
  const identityToken = typeof body.identity_token === "string" ? body.identity_token : null;
  const deviceId      = typeof body.device_id === "string" ? body.device_id : null;
  const expoToken     = typeof body.expo_token === "string" ? body.expo_token : null;
  const platform      = body.platform === "ios" || body.platform === "android" ? body.platform : null;

  if (!identityToken || !deviceId || !expoToken || !platform) {
    return jsonError("missing_fields", "identity_token, device_id, expo_token, platform required", 400);
  }

  // Verify Apple identity token
  const claims = await verifyAppleIdentityToken(identityToken, env.APPLE_CLIENT_ID);
  if (!claims) {
    return jsonError("invalid_identity_token", "Apple identity token verification failed", 401);
  }

  // Allowlist check
  const allowed = await env.DASHBOARD_DB
    .prepare("SELECT 1 FROM mobile_allowlist WHERE provider='apple' AND sub=?")
    .bind(claims.sub)
    .first<{ 1: number }>();
  if (!allowed) {
    return jsonError("not_allowed", "Apple identity not on allowlist", 403);
  }

  // Upsert mobile_device
  const now = Date.now();
  await env.DASHBOARD_DB
    .prepare(
      "INSERT INTO mobile_device (device_id, expo_token, platform, sub_id, auth_provider, push_prefs, registered_at, last_seen_at, active)" +
      " VALUES (?, ?, ?, ?, 'apple', '{}', ?, ?, 1)" +
      " ON CONFLICT(device_id) DO UPDATE SET expo_token=excluded.expo_token, last_seen_at=excluded.last_seen_at, active=1"
    )
    .bind(deviceId, expoToken, platform, claims.sub, now, now)
    .run();

  // Mint JWT pair
  const tokens = await mintTokenPair(claims.sub, "apple", deviceId, env.DASHBOARD_DB, env.MOBILE_JWT_SIGNING_KEY);

  return json({
    access_token:      tokens.access_token,
    refresh_token_id:  tokens.refresh_token_id,
    refresh_secret:    tokens.refresh_secret,
    sub:               claims.sub,
    provider:          "apple",
  }, 200);
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/auth/google
// ---------------------------------------------------------------------------

async function handleAuthGoogle(request: Request, env: MobileEnv): Promise<Response> {
  const bodyResult = await readBodyJson(request);
  if (!bodyResult.ok) return bodyResult.response;

  const body = bodyResult.data as Record<string, unknown>;
  const identityToken = typeof body.identity_token === "string" ? body.identity_token : null;
  const deviceId      = typeof body.device_id === "string" ? body.device_id : null;
  const expoToken     = typeof body.expo_token === "string" ? body.expo_token : null;
  const platform      = body.platform === "ios" || body.platform === "android" ? body.platform : null;

  if (!identityToken || !deviceId || !expoToken || !platform) {
    return jsonError("missing_fields", "identity_token, device_id, expo_token, platform required", 400);
  }

  const claims = await verifyGoogleIdentityToken(identityToken, env.GOOGLE_CLIENT_ID);
  if (!claims) {
    return jsonError("invalid_identity_token", "Google identity token verification failed", 401);
  }

  const allowed = await env.DASHBOARD_DB
    .prepare("SELECT 1 FROM mobile_allowlist WHERE provider='google' AND sub=?")
    .bind(claims.sub)
    .first<{ 1: number }>();
  if (!allowed) {
    return jsonError("not_allowed", "Google identity not on allowlist", 403);
  }

  const now = Date.now();
  await env.DASHBOARD_DB
    .prepare(
      "INSERT INTO mobile_device (device_id, expo_token, platform, sub_id, auth_provider, push_prefs, registered_at, last_seen_at, active)" +
      " VALUES (?, ?, ?, ?, 'google', '{}', ?, ?, 1)" +
      " ON CONFLICT(device_id) DO UPDATE SET expo_token=excluded.expo_token, last_seen_at=excluded.last_seen_at, active=1"
    )
    .bind(deviceId, expoToken, platform, claims.sub, now, now)
    .run();

  const tokens = await mintTokenPair(claims.sub, "google", deviceId, env.DASHBOARD_DB, env.MOBILE_JWT_SIGNING_KEY);

  return json({
    access_token:      tokens.access_token,
    refresh_token_id:  tokens.refresh_token_id,
    refresh_secret:    tokens.refresh_secret,
    sub:               claims.sub,
    provider:          "google",
  }, 200);
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/auth/refresh
// ---------------------------------------------------------------------------

async function handleAuthRefresh(request: Request, env: MobileEnv): Promise<Response> {
  const bodyResult = await readBodyJson(request);
  if (!bodyResult.ok) return bodyResult.response;

  const body = bodyResult.data as Record<string, unknown>;
  const tokenId = typeof body.refresh_token_id === "string" ? body.refresh_token_id : null;
  const secret  = typeof body.refresh_secret   === "string" ? body.refresh_secret   : null;

  if (!tokenId || !secret) {
    return jsonError("missing_fields", "refresh_token_id and refresh_secret required", 400);
  }

  const result = await consumeRefreshToken(tokenId, secret, env.DASHBOARD_DB);
  if (!result) {
    return jsonError("invalid_refresh_token", "Refresh token invalid, expired, or already used", 401);
  }

  // Load device to reconstruct sub + provider for new access token
  const device = await env.DASHBOARD_DB
    .prepare("SELECT sub_id, auth_provider FROM mobile_device WHERE device_id=? AND active=1")
    .bind(result.device_id)
    .first<{ sub_id: string; auth_provider: string }>();

  if (!device) {
    return jsonError("device_not_found", "Device no longer registered", 404);
  }

  if (device.auth_provider !== "apple" && device.auth_provider !== "google") {
    return jsonError("invalid_device", "Device has unknown auth provider", 500);
  }

  // Update last_seen_at
  await env.DASHBOARD_DB
    .prepare("UPDATE mobile_device SET last_seen_at=? WHERE device_id=?")
    .bind(Date.now(), result.device_id)
    .run();

  const tokens = await mintTokenPair(
    device.sub_id,
    device.auth_provider as "apple" | "google",
    result.device_id,
    env.DASHBOARD_DB,
    env.MOBILE_JWT_SIGNING_KEY
  );

  return json({
    access_token:     tokens.access_token,
    refresh_token_id: tokens.refresh_token_id,
    refresh_secret:   tokens.refresh_secret,
  }, 200);
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/push/register
// ---------------------------------------------------------------------------

async function handlePushRegister(request: Request, env: MobileEnv, ctx: MobileJwtContext): Promise<Response> {
  const bodyResult = await readBodyJson(request);
  if (!bodyResult.ok) return bodyResult.response;

  const body = bodyResult.data as Record<string, unknown>;
  const expoToken = typeof body.expo_token === "string" ? body.expo_token : null;
  const platform  = body.platform === "ios" || body.platform === "android" ? body.platform : null;
  const pushPrefs = typeof body.push_prefs === "object" && body.push_prefs !== null
    ? JSON.stringify(body.push_prefs) : "{}";

  if (!expoToken || !platform) {
    return jsonError("missing_fields", "expo_token and platform required", 400);
  }

  const now = Date.now();
  await env.DASHBOARD_DB
    .prepare(
      "INSERT INTO mobile_device (device_id, expo_token, platform, sub_id, auth_provider, push_prefs, registered_at, last_seen_at, active)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)" +
      " ON CONFLICT(device_id) DO UPDATE SET" +
      "   expo_token=excluded.expo_token," +
      "   platform=excluded.platform," +
      "   push_prefs=excluded.push_prefs," +
      "   last_seen_at=excluded.last_seen_at," +
      "   active=1"
    )
    .bind(ctx.device_id, expoToken, platform, ctx.sub, ctx.provider, pushPrefs, now, now)
    .run();

  return json({ ok: true, device_id: ctx.device_id }, 200);
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/push/unregister
// ---------------------------------------------------------------------------

async function handlePushUnregister(_request: Request, env: MobileEnv, ctx: MobileJwtContext): Promise<Response> {
  await env.DASHBOARD_DB
    .prepare("UPDATE mobile_device SET active=0 WHERE device_id=?")
    .bind(ctx.device_id)
    .run();
  return json({ ok: true }, 200);
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/push/dispatch
// Two shapes:
//   { signal, query: 'devices' }  → return active devices (daemon introspection)
//   { signal, payload, defaults_on: [...] } → query + dispatch to Expo + log
// ---------------------------------------------------------------------------

interface ExpoMessage {
  to:    string;
  title: string;
  body:  string;
  data?: Record<string, unknown>;
}

async function sendExpoPush(messages: ExpoMessage[]): Promise<{ results: { status: string; id?: string; message?: string }[] }> {
  const resp = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });

  if (!resp.ok) {
    throw new Error(`Expo Push API error: ${resp.status}`);
  }

  const result = await resp.json() as { data: { status: string; id?: string; message?: string }[] };
  return { results: result.data ?? [] };
}

async function handlePushDispatch(request: Request, env: MobileEnv): Promise<Response> {
  if (!requirePushSecret(request, env)) {
    return new Response(null, { status: 401 });
  }

  const bodyResult = await readBodyJson(request, 32 * 1024);
  if (!bodyResult.ok) return bodyResult.response;

  const body = bodyResult.data as Record<string, unknown>;
  const signal = typeof body.signal === "string" ? body.signal : null;
  if (!signal) {
    return jsonError("missing_fields", "signal required", 400);
  }

  // Query shape: return active devices
  if (body.query === "devices") {
    const defaultsOn = Array.isArray(body.defaults_on) ? body.defaults_on as string[] : [];
    const rows = await env.DASHBOARD_DB
      .prepare("SELECT device_id, expo_token, platform, sub_id, auth_provider, push_prefs FROM mobile_device WHERE active=1")
      .all<DeviceRow>();

    const devices = rows.results.map((d) => {
      const prefs = parsePrefs(d.push_prefs);
      const explicitly = typeof prefs[signal] === "boolean" ? prefs[signal] : null;
      // Signal is enabled if: explicit true, OR (no explicit override AND signal in defaults_on)
      const enabled = explicitly === true || (explicitly === null && defaultsOn.includes(signal));
      return {
        device_id:     d.device_id,
        expo_token:    d.expo_token,
        platform:      d.platform,
        push_enabled:  enabled,
      };
    });

    return json({ devices }, 200);
  }

  // Dispatch shape: send push to eligible devices
  const pushPayload = typeof body.payload === "object" && body.payload !== null
    ? body.payload as Record<string, unknown>
    : {};
  const defaultsOn = Array.isArray(body.defaults_on) ? body.defaults_on as string[] : [];

  const rows = await env.DASHBOARD_DB
    .prepare("SELECT device_id, expo_token, platform, push_prefs FROM mobile_device WHERE active=1")
    .all<Pick<DeviceRow, "device_id" | "expo_token" | "platform" | "push_prefs">>();

  const eligibleDevices = rows.results.filter((d) => {
    const prefs = parsePrefs(d.push_prefs);
    const explicit = typeof prefs[signal] === "boolean" ? prefs[signal] : null;
    return explicit === true || (explicit === null && defaultsOn.includes(signal));
  });

  if (eligibleDevices.length === 0) {
    return json({ dispatched: 0, skipped: rows.results.length }, 200);
  }

  // Build Expo messages
  const notifTitle  = typeof pushPayload.title  === "string" ? pushPayload.title  : `Factory: ${signal}`;
  const notifBody   = typeof pushPayload.body    === "string" ? pushPayload.body   : signal;
  const notifData   = typeof pushPayload.data    === "object" && pushPayload.data !== null
    ? pushPayload.data as Record<string, unknown> : {};

  const messages: ExpoMessage[] = eligibleDevices.map((d) => ({
    to:    d.expo_token,
    title: notifTitle,
    body:  notifBody,
    data:  { ...notifData, signal },
  }));

  const now = Date.now();
  let expoResults: { status: string; id?: string; message?: string }[] = [];
  let expoError: string | null = null;

  try {
    const expoResp = await sendExpoPush(messages);
    expoResults = expoResp.results;
  } catch (err) {
    expoError = err instanceof Error ? err.message : "unknown expo error";
  }

  // Log results to mobile_push_log
  const logStmts = eligibleDevices.map((d, idx) => {
    const result = expoResults[idx];
    const status = expoError
      ? "error"
      : (result?.status === "ok" ? "ok" : "error");
    const errorMsg = expoError ?? result?.message ?? null;

    return env.DASHBOARD_DB
      .prepare(
        "INSERT INTO mobile_push_log (ts, signal, device_id, expo_status, error_msg) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(now, signal, d.device_id, status, errorMsg);
  });

  if (logStmts.length > 0) {
    // Best-effort log; don't fail dispatch on log write error
    try {
      for (let i = 0; i < logStmts.length; i += 50) {
        await env.DASHBOARD_DB.batch(logStmts.slice(i, i + 50));
      }
    } catch {
      // log write failed — dispatch succeeded, continue
    }
  }

  if (expoError) {
    return json({ error: "expo_push_failed", message: expoError }, 502);
  }

  const okCount = expoResults.filter((r) => r?.status === "ok").length;
  return json({
    dispatched:  eligibleDevices.length,
    ok:          okCount,
    errored:     eligibleDevices.length - okCount,
    skipped:     rows.results.length - eligibleDevices.length,
  }, 200);
}

function parsePrefs(raw: string): Record<string, boolean> {
  try {
    const p = JSON.parse(raw);
    if (typeof p === "object" && p !== null) return p as Record<string, boolean>;
  } catch { /* fall through */ }
  return {};
}

// ---------------------------------------------------------------------------
// Route: GET /mobile/runs
// ---------------------------------------------------------------------------

async function handleGetRuns(env: MobileEnv): Promise<Response> {
  const rows = await env.DASHBOARD_DB
    .prepare(
      "SELECT run_id, pipeline_type, status, started_at, ended_at, updated_at FROM pipeline_detail" +
      " ORDER BY updated_at DESC LIMIT 50"
    )
    .all<Pick<RunRow, "run_id" | "pipeline_type" | "status" | "started_at" | "ended_at" | "updated_at">>();

  const runs = rows.results.map((r) => ({
    run_id:       r.run_id,
    pipeline:     r.pipeline_type,
    status:       r.status,
    started_at:   new Date(r.started_at).toISOString(),
    ended_at:     r.ended_at ? new Date(r.ended_at).toISOString() : null,
    updated_at:   new Date(r.updated_at).toISOString(),
  }));

  return json({ runs }, 200);
}

// ---------------------------------------------------------------------------
// Route: GET /mobile/runs/:run_id
// ---------------------------------------------------------------------------

async function handleGetRun(env: MobileEnv, runId: string): Promise<Response> {
  // Validate run_id format to prevent injection
  if (!/^[0-9]{8}_[0-9]{6}$/.test(runId)) {
    return jsonError("invalid_run_id", "Invalid run_id format", 400);
  }

  const row = await env.DASHBOARD_DB
    .prepare(
      "SELECT run_id, pipeline_type, status, started_at, ended_at, payload, updated_at FROM pipeline_detail WHERE run_id=?"
    )
    .bind(runId)
    .first<RunRow>();

  if (!row) return jsonError("not_found", "Run not found", 404);

  let detail: Record<string, unknown> = {};
  try { detail = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* use empty */ }

  // Task tree
  const ttRow = await env.DASHBOARD_DB
    .prepare("SELECT payload FROM task_tree_snapshot WHERE run_id=?")
    .bind(runId)
    .first<{ payload: string }>();

  let taskTree: unknown = null;
  if (ttRow) {
    try { taskTree = JSON.parse(ttRow.payload); } catch { /* skip */ }
  }

  return json({
    run_id:    row.run_id,
    pipeline:  row.pipeline_type,
    status:    row.status,
    started_at: new Date(row.started_at).toISOString(),
    ended_at:  row.ended_at ? new Date(row.ended_at).toISOString() : null,
    updated_at: new Date(row.updated_at).toISOString(),
    detail,
    task_tree: taskTree,
  }, 200);
}

// ---------------------------------------------------------------------------
// Route: GET /mobile/comms  (?priority=p0&since=<ts>&limit=30)
// ---------------------------------------------------------------------------

async function handleGetComms(request: Request, env: MobileEnv): Promise<Response> {
  const url      = new URL(request.url);
  const priority = url.searchParams.get("priority");
  const sinceRaw = url.searchParams.get("since");
  const limit    = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10), 100);

  const sinceMs = sinceRaw ? new Date(sinceRaw).getTime() : 0;

  const rows = await env.DASHBOARD_DB
    .prepare(
      "SELECT filename, from_agent, to_agent, priority, thread_id, subject, payload, ts" +
      " FROM comm_message" +
      " WHERE (? IS NULL OR priority=?) AND ts > ?" +
      " ORDER BY ts DESC LIMIT ?"
    )
    .bind(priority, priority, sinceMs, limit)
    .all<CommRow>();

  const comms = rows.results.map((r) => ({
    filename:   r.filename,
    from:       r.from_agent,
    to:         r.to_agent,
    priority:   r.priority,
    thread_id:  r.thread_id ?? null,
    subject:    r.subject ?? null,
    body_md:    r.payload,
    ts:         new Date(r.ts).toISOString(),
  }));

  return json({ comms }, 200);
}

// ---------------------------------------------------------------------------
// Route: GET /mobile/comms/threads  (?cursor=<last_msg_ts>&limit=50&priority=p0|p1|p2)
// ---------------------------------------------------------------------------

interface CommThreadRow {
  thread_id:    string;
  subject:      string | null;
  priority:     string;
  last_msg_ts:  number;
  msg_count:    number;
  last_sender:  string;
}

async function handleGetCommThreadsList(request: Request, env: MobileEnv): Promise<Response> {
  const url       = new URL(request.url);
  const cursorRaw = url.searchParams.get("cursor");
  const priority  = url.searchParams.get("priority");
  const limit     = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
  const cursorMs  = cursorRaw ? new Date(cursorRaw).getTime() : Date.now() + 1;

  const rows = await env.DASHBOARD_DB
    .prepare(
      "SELECT thread_id, subject, priority, last_msg_ts, msg_count, last_sender" +
      " FROM comm_thread" +
      " WHERE last_msg_ts < ? AND (? IS NULL OR priority=?)" +
      " ORDER BY last_msg_ts DESC LIMIT ?"
    )
    .bind(cursorMs, priority, priority, limit)
    .all<CommThreadRow>();

  const threads = rows.results.map((r) => ({
    thread_id:   r.thread_id,
    subject:     r.subject ?? null,
    priority:    r.priority,
    last_msg_ts: new Date(r.last_msg_ts).toISOString(),
    msg_count:   r.msg_count,
    last_sender: r.last_sender,
  }));

  return json({ threads }, 200);
}

// ---------------------------------------------------------------------------
// Route: GET /mobile/comms/threads/:tid
// ---------------------------------------------------------------------------

async function handleGetCommThread(env: MobileEnv, tid: string): Promise<Response> {
  // thread_id is a filename-derived identifier; sanitise
  if (!/^[a-zA-Z0-9_\-.]+$/.test(tid)) {
    return jsonError("invalid_thread_id", "Invalid thread_id", 400);
  }

  const rows = await env.DASHBOARD_DB
    .prepare(
      "SELECT filename, from_agent, to_agent, priority, thread_id, subject, payload, ts" +
      " FROM comm_message WHERE thread_id=? ORDER BY ts ASC"
    )
    .bind(tid)
    .all<CommRow>();

  if (rows.results.length === 0) {
    return jsonError("not_found", "Thread not found", 404);
  }

  const messages = rows.results.map((r) => ({
    filename:  r.filename,
    from:      r.from_agent,
    to:        r.to_agent,
    priority:  r.priority,
    subject:   r.subject ?? null,
    body_md:   r.payload,
    ts:        new Date(r.ts).toISOString(),
  }));

  return json({ thread_id: tid, messages }, 200);
}

// ---------------------------------------------------------------------------
// Route: GET /mobile/sessions  (?status=active|archived)
// ---------------------------------------------------------------------------

async function handleGetSessions(request: Request, env: MobileEnv): Promise<Response> {
  const url    = new URL(request.url);
  const status = url.searchParams.get("status");

  const rows = await env.DASHBOARD_DB
    .prepare(
      "SELECT session_id, status, started_at, last_msg_at, msg_count, title" +
      " FROM intake_session" +
      " WHERE (? IS NULL OR status=?)" +
      " ORDER BY last_msg_at DESC LIMIT 50"
    )
    .bind(status, status)
    .all<SessionRow>();

  const sessions = rows.results.map((r) => ({
    session_id:  r.session_id,
    status:      r.status,
    started_at:  new Date(r.started_at).toISOString(),
    last_msg_at: new Date(r.last_msg_at).toISOString(),
    msg_count:   r.msg_count,
    title:       r.title ?? null,
  }));

  return json({ sessions }, 200);
}

// ---------------------------------------------------------------------------
// Route: GET /mobile/sessions/:sid
// ---------------------------------------------------------------------------

async function handleGetSession(env: MobileEnv, sid: string): Promise<Response> {
  // session_id is YYYYMMDDTHHMMSSZ
  if (!/^[0-9]{8}T[0-9]{6}Z$/.test(sid)) {
    return jsonError("invalid_session_id", "Invalid session_id format", 400);
  }

  const meta = await env.DASHBOARD_DB
    .prepare("SELECT session_id, status, started_at, last_msg_at, msg_count, title FROM intake_session WHERE session_id=?")
    .bind(sid)
    .first<SessionRow>();

  if (!meta) return jsonError("not_found", "Session not found", 404);

  // Get session metadata from brainstorm_session
  const bsRow = await env.DASHBOARD_DB
    .prepare("SELECT session_id, started_at, last_ts, turn_count, outcome, total_chunks FROM brainstorm_session WHERE session_id=?")
    .bind(sid)
    .first<BrainstormSessionRow>();

  // Get per-turn payload chunks ordered by chunk_idx
  const chunkRows = await env.DASHBOARD_DB
    .prepare("SELECT session_id, chunk_idx, payload FROM brainstorm_session_chunk WHERE session_id=? ORDER BY chunk_idx ASC")
    .bind(sid)
    .all<BrainstormChunkRow>();

  const chunks = chunkRows.results.map((c) => ({ chunk_idx: c.chunk_idx, payload: c.payload }));

  return json({
    session_id:         meta.session_id,
    status:             meta.status,
    started_at:         new Date(meta.started_at).toISOString(),
    last_msg_at:        new Date(meta.last_msg_at).toISOString(),
    msg_count:          meta.msg_count,
    title:              meta.title ?? null,
    turn_count:         bsRow?.turn_count ?? null,
    outcome:            bsRow?.outcome ?? null,
    total_chunks:       bsRow?.total_chunks ?? null,
    content_updated_at: bsRow ? new Date(bsRow.last_ts).toISOString() : null,
    chunks,
  }, 200);
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/intake
// Body: { session_id?, message, source: 'mobile', client_msg_id? }
// ---------------------------------------------------------------------------

async function handleIntake(request: Request, env: MobileEnv): Promise<Response> {
  const bodyResult = await readBodyJson(request, 32 * 1024);
  if (!bodyResult.ok) return bodyResult.response;

  const body = bodyResult.data as Record<string, unknown>;
  const message       = typeof body.message === "string" ? body.message.trim() : null;
  const sessionId     = typeof body.session_id === "string" ? body.session_id : null;
  const clientMsgId   = typeof body.client_msg_id === "string" ? body.client_msg_id : null;

  if (!message || message.length === 0) {
    return jsonError("missing_fields", "message required and must be non-empty", 400);
  }
  if (message.length > 10_000) {
    return jsonError("message_too_long", "message must be ≤10,000 characters", 400);
  }

  const queuePayload = {
    message,
    source: "mobile",
    ...(sessionId     ? { session_id:     sessionId }   : {}),
    ...(clientMsgId   ? { client_msg_id:  clientMsgId } : {}),
    enqueued_at: new Date().toISOString(),
  };

  try {
    await env.MOBILE_INTAKE_QUEUE.send(queuePayload);
  } catch (err) {
    // Queue full or unavailable — return 503 with Retry-After
    return new Response(
      JSON.stringify({ error: "queue_unavailable", message: "Intake queue unavailable, retry shortly" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "5" },
      }
    );
  }

  return json({ ok: true, queued: true }, 202);
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/intake/confirm
// Body: { intent_id }
// ---------------------------------------------------------------------------

async function handleIntakeConfirm(request: Request, env: MobileEnv): Promise<Response> {
  const bodyResult = await readBodyJson(request, 4 * 1024);
  if (!bodyResult.ok) return bodyResult.response;

  const body = bodyResult.data as Record<string, unknown>;
  const intentId = typeof body.intent_id === "string" ? body.intent_id.trim() : null;

  if (!intentId) {
    return jsonError("missing_fields", "intent_id required", 400);
  }
  // Validate intent_id format (prevent injection — intent IDs are ISO-ish timestamps)
  if (!/^[a-zA-Z0-9_\-:.T]+$/.test(intentId) || intentId.length > 64) {
    return jsonError("invalid_intent_id", "intent_id format invalid", 400);
  }

  const queuePayload = {
    intent_id: intentId,
    action:    "confirm",
    source:    "mobile",
    confirmed_at: new Date().toISOString(),
  };

  try {
    await env.MOBILE_INTAKE_QUEUE.send(queuePayload);
  } catch {
    return new Response(
      JSON.stringify({ error: "queue_unavailable", message: "Queue unavailable, retry shortly" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "5" },
      }
    );
  }

  return json({ ok: true, queued: true }, 202);
}

// ---------------------------------------------------------------------------
// Route: POST /mobile/voice/transcribe — STUB (Whisper key not yet provisioned)
// ---------------------------------------------------------------------------

function handleVoiceTranscribe(): Response {
  return new Response(
    JSON.stringify({ error: "voice_not_provisioned", message: "Voice transcription not yet available. See architect spec OQ #7." }),
    {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }
  );
}

// ---------------------------------------------------------------------------
// Main router — called from index.ts
// ---------------------------------------------------------------------------

/**
 * Handle any /mobile/* request. Returns null if the path is not a mobile route
 * (allows index.ts to fall through to 404).
 */
export async function handleMobileRoutes(
  request: Request,
  path: string,
  env: MobileEnv
): Promise<Response | null> {
  const method = request.method;

  // ── Auth routes (no JWT required) ────────────────────────────────────────
  if (method === "POST" && path === "/mobile/auth/apple") {
    return handleAuthApple(request, env);
  }
  if (method === "POST" && path === "/mobile/auth/google") {
    return handleAuthGoogle(request, env);
  }
  if (method === "POST" && path === "/mobile/auth/refresh") {
    return handleAuthRefresh(request, env);
  }

  // ── Push dispatch (daemon-to-Worker bearer auth, not mobile JWT) ─────────
  if (method === "POST" && path === "/mobile/push/dispatch") {
    return handlePushDispatch(request, env);
  }

  // ── SSE events (JWT required) ─────────────────────────────────────────────
  if (method === "GET" && path === "/mobile/events") {
    const authResult = await resolveMobileAuth(request, env);
    if (!authResult.ok) return authResult.response;
    return handleMobileSSE(request, env);
  }

  // ── Voice transcribe stub ─────────────────────────────────────────────────
  if (method === "POST" && path === "/mobile/voice/transcribe") {
    const authResult = await resolveMobileAuth(request, env);
    if (!authResult.ok) return authResult.response;
    return handleVoiceTranscribe();
  }

  // ── JWT-gated routes ──────────────────────────────────────────────────────
  const authResult = await resolveMobileAuth(request, env);
  if (!authResult.ok) {
    // Only return 401 if the path is a known mobile route
    if (path.startsWith("/mobile/")) return authResult.response;
    return null;
  }
  const ctx = authResult.ctx;

  if (method === "POST" && path === "/mobile/push/register") {
    return handlePushRegister(request, env, ctx);
  }
  if (method === "POST" && path === "/mobile/push/unregister") {
    return handlePushUnregister(request, env, ctx);
  }

  if (method === "GET" && path === "/mobile/runs") {
    return handleGetRuns(env);
  }
  if (method === "GET" && path.startsWith("/mobile/runs/")) {
    const runId = path.slice("/mobile/runs/".length);
    if (!runId) return jsonError("missing_run_id", "run_id required", 400);
    return handleGetRun(env, runId);
  }

  if (method === "GET" && path === "/mobile/comms") {
    return handleGetComms(request, env);
  }
  if (method === "GET" && path === "/mobile/comms/threads") {
    return handleGetCommThreadsList(request, env);
  }
  if (method === "GET" && path.startsWith("/mobile/comms/threads/")) {
    const tid = path.slice("/mobile/comms/threads/".length);
    if (!tid) return jsonError("missing_thread_id", "thread_id required", 400);
    return handleGetCommThread(env, tid);
  }

  if (method === "GET" && path === "/mobile/sessions") {
    return handleGetSessions(request, env);
  }
  if (method === "GET" && path.startsWith("/mobile/sessions/")) {
    const sid = path.slice("/mobile/sessions/".length);
    if (!sid) return jsonError("missing_session_id", "session_id required", 400);
    return handleGetSession(env, sid);
  }

  if (method === "POST" && path === "/mobile/intake") {
    return handleIntake(request, env);
  }
  if (method === "POST" && path === "/mobile/intake/confirm") {
    return handleIntakeConfirm(request, env);
  }

  // Unknown /mobile/* route
  if (path.startsWith("/mobile/")) {
    return jsonError("not_found", "Mobile route not found", 404);
  }

  return null; // not a mobile route
}
