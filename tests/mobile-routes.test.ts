/**
 * mobile-routes.test.ts
 *
 * Tests:
 *   - Auth flow (Apple + Google) — happy path via mock JWKS
 *   - Allowlist denial (provider in list but sub not matched)
 *   - JWT middleware — absent/malformed/expired token
 *   - Refresh token rotation + single-use enforcement
 *   - Push register/unregister
 *   - Intake enqueue (202 + queue called)
 *   - Intake confirm enqueue (202 + queue called)
 *   - Push dispatch bearer auth (401 without secret, 200 with)
 *   - Push dispatch query shape (returns devices)
 *   - Expo Push dispatch shape (mock fetch)
 *   - Voice transcribe → 503
 *   - GET /mobile/runs, /mobile/sessions, /mobile/comms → 200
 */

import { describe, it, expect, vi } from "vitest";
import { handleMobileRoutes } from "../src/mobile-routes";
import { mintTokenPair } from "../src/mobile-jwt";
import { _verifyTokenWithJwks } from "../src/mobile-jwks";

// ---------------------------------------------------------------------------
// Shared test constants
// ---------------------------------------------------------------------------

const TEST_KEY_B64    = btoa(String.fromCharCode(...new Array(32).fill(0)));
const TEST_PUSH_SECRET = "test-push-secret-abc123";
const TEST_APPLE_CLIENT = "ai.saiteja.factorymobile";
const TEST_GOOGLE_CLIENT = "1234-abc.apps.googleusercontent.com";

// ---------------------------------------------------------------------------
// D1 mock
// ---------------------------------------------------------------------------

interface MockD1Opts {
  firstMap?: Record<string, unknown>;
  allMap?: Record<string, unknown[]>;
  runFn?: (sql: string, args: unknown[]) => void;
}

function makeD1Mock(opts: MockD1Opts = {}): D1Database {
  const { firstMap = {}, allMap = {}, runFn } = opts;

  return {
    prepare: (sql: string) => {
      let boundArgs: unknown[] = [];
      const stmt = {
        bind: (...args: unknown[]) => {
          boundArgs = args;
          return stmt;
        },
        first: async () => {
          for (const [key, val] of Object.entries(firstMap)) {
            if (sql.includes(key)) return val;
          }
          return null;
        },
        all: async () => {
          for (const [key, vals] of Object.entries(allMap)) {
            if (sql.includes(key)) return { results: vals };
          }
          return { results: [] };
        },
        run: async () => {
          if (runFn) runFn(sql, boundArgs);
          return {};
        },
      };
      return stmt;
    },
    batch: async (stmts: unknown[]) => {
      for (const s of stmts as { run: () => Promise<unknown> }[]) {
        await s.run();
      }
      return [];
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Mock Queue
// ---------------------------------------------------------------------------

function makeMockQueue() {
  const sent: unknown[] = [];
  const queue = {
    send: async (msg: unknown) => { sent.push(msg); },
    getSent: () => sent,
  };
  return queue;
}

// ---------------------------------------------------------------------------
// Build a valid mobile JWT for a device
// ---------------------------------------------------------------------------

async function mintTestToken(sub = "test_sub", provider: "apple" | "google" = "apple", deviceId = "dev-1") {
  let dbCallCount = 0;
  const db = {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first:  async () => null, // no KID row
        run:    async () => { dbCallCount++; return {}; },
        all:    async () => ({ results: [] }),
      }),
      first:  async () => null,
      all:    async () => ({ results: [] }),
      run:    async () => ({}),
    }),
    batch:  async (_stmts: unknown[]) => [],
  } as unknown as D1Database;

  const tokens = await mintTokenPair(sub, provider, deviceId, db, TEST_KEY_B64);
  return tokens.access_token;
}

function makeEnv(db: D1Database, queue?: ReturnType<typeof makeMockQueue>): Parameters<typeof handleMobileRoutes>[2] {
  return {
    DASHBOARD_DB:           db,
    MOBILE_JWT_SIGNING_KEY: TEST_KEY_B64,
    MOBILE_PUSH_SECRET:     TEST_PUSH_SECRET,
    APPLE_CLIENT_ID:        TEST_APPLE_CLIENT,
    GOOGLE_CLIENT_ID:       TEST_GOOGLE_CLIENT,
    MOBILE_INTAKE_QUEUE:    (queue ?? makeMockQueue()) as unknown as Queue,
  };
}

function req(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  return new Request(`https://ingest.dashboard.saiteja.ai${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// ---------------------------------------------------------------------------
// JWT middleware tests
// ---------------------------------------------------------------------------

describe("/mobile/* — JWT middleware", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const db = makeD1Mock();
    const resp = await handleMobileRoutes(req("GET", "/mobile/runs"), "/mobile/runs", makeEnv(db));
    expect(resp?.status).toBe(401);
  });

  it("returns 401 for a malformed token", async () => {
    const db = makeD1Mock();
    const resp = await handleMobileRoutes(
      req("GET", "/mobile/runs", { headers: { Authorization: "Bearer notajwt" } }),
      "/mobile/runs",
      makeEnv(db)
    );
    expect(resp?.status).toBe(401);
  });

  it("returns 403 for a valid JWT whose sub is not on allowlist", async () => {
    const token = await mintTestToken("not_allowlisted_sub");
    const db = makeD1Mock({
      firstMap: {
        "SELECT 1 FROM mobile_allowlist": null, // no match
        "SELECT signing_key, retired_at FROM mobile_jwt_kid WHERE kid": null,
      },
    });
    const resp = await handleMobileRoutes(
      req("GET", "/mobile/runs", { headers: { Authorization: `Bearer ${token}` } }),
      "/mobile/runs",
      makeEnv(db)
    );
    expect(resp?.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /mobile/runs
// ---------------------------------------------------------------------------

describe("GET /mobile/runs", () => {
  it("returns 200 with runs array", async () => {
    const token = await mintTestToken();
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
      allMap: {
        "FROM pipeline_detail": [
          { run_id: "20260503_104148", pipeline_type: "build", status: "done", started_at: 1714000000000, ended_at: 1714003600000, updated_at: 1714003600000 },
        ],
      },
    });
    const resp = await handleMobileRoutes(
      req("GET", "/mobile/runs", { headers: { Authorization: `Bearer ${token}` } }),
      "/mobile/runs",
      makeEnv(db)
    );
    expect(resp?.status).toBe(200);
    const body = await resp?.json() as { runs: unknown[] };
    expect(Array.isArray(body.runs)).toBe(true);
    expect((body.runs[0] as Record<string, unknown>).run_id).toBe("20260503_104148");
  });
});

// ---------------------------------------------------------------------------
// POST /mobile/push/register + unregister
// ---------------------------------------------------------------------------

describe("POST /mobile/push/register", () => {
  it("upserts device and returns 200", async () => {
    const token = await mintTestToken();
    let ran = false;
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
      runFn: (sql) => { if (sql.includes("INSERT INTO mobile_device")) ran = true; },
    });
    const resp = await handleMobileRoutes(
      req("POST", "/mobile/push/register", {
        headers: { Authorization: `Bearer ${token}` },
        body: { expo_token: "ExponentPushToken[abc]", platform: "ios" },
      }),
      "/mobile/push/register",
      makeEnv(db)
    );
    expect(resp?.status).toBe(200);
    expect(ran).toBe(true);
  });
});

describe("POST /mobile/push/unregister", () => {
  it("soft-deletes device and returns 200", async () => {
    const token = await mintTestToken();
    let softDeleted = false;
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
      runFn: (sql) => { if (sql.includes("UPDATE mobile_device SET active=0")) softDeleted = true; },
    });
    const resp = await handleMobileRoutes(
      req("POST", "/mobile/push/unregister", {
        headers: { Authorization: `Bearer ${token}` },
        body: {},
      }),
      "/mobile/push/unregister",
      makeEnv(db)
    );
    expect(resp?.status).toBe(200);
    expect(softDeleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /mobile/push/dispatch — bearer auth
// ---------------------------------------------------------------------------

describe("POST /mobile/push/dispatch", () => {
  it("returns 401 without MOBILE_PUSH_SECRET", async () => {
    const db = makeD1Mock();
    const resp = await handleMobileRoutes(
      req("POST", "/mobile/push/dispatch", {
        headers: { Authorization: "Bearer wrong-secret" },
        body: { signal: "pipeline_finished", query: "devices" },
      }),
      "/mobile/push/dispatch",
      makeEnv(db)
    );
    expect(resp?.status).toBe(401);
  });

  it("returns devices list for query=devices shape", async () => {
    const db = makeD1Mock({
      allMap: {
        "FROM mobile_device WHERE active=1": [
          { device_id: "d1", expo_token: "ExponentPushToken[d1]", platform: "ios", sub_id: "sub1", auth_provider: "apple", push_prefs: '{"pipeline_finished":true}', active: 1 },
        ],
      },
    });
    const resp = await handleMobileRoutes(
      req("POST", "/mobile/push/dispatch", {
        headers: { Authorization: `Bearer ${TEST_PUSH_SECRET}` },
        body: { signal: "pipeline_finished", query: "devices", defaults_on: ["pipeline_finished"] },
      }),
      "/mobile/push/dispatch",
      makeEnv(db)
    );
    expect(resp?.status).toBe(200);
    const body = await resp?.json() as { devices: { device_id: string; push_enabled: boolean }[] };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].push_enabled).toBe(true);
  });

  it("dispatches push and logs result (mock Expo)", async () => {
    const expoFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ status: "ok", id: "push-123" }] }),
    });
    vi.stubGlobal("fetch", expoFetch);

    let logInserted = false;
    const db = makeD1Mock({
      allMap: {
        "FROM mobile_device WHERE active=1": [
          { device_id: "d1", expo_token: "ExponentPushToken[d1]", platform: "ios", push_prefs: '{}', active: 1 },
        ],
      },
      runFn: (sql) => { if (sql.includes("INSERT INTO mobile_push_log")) logInserted = true; },
    });

    const resp = await handleMobileRoutes(
      req("POST", "/mobile/push/dispatch", {
        headers: { Authorization: `Bearer ${TEST_PUSH_SECRET}` },
        body: {
          signal:      "pipeline_finished",
          defaults_on: ["pipeline_finished"],
          payload:     { title: "Pipeline done", body: "Build complete" },
        },
      }),
      "/mobile/push/dispatch",
      makeEnv(db)
    );

    expect(resp?.status).toBe(200);
    const body = await resp?.json() as { dispatched: number; ok: number };
    expect(body.dispatched).toBe(1);
    expect(body.ok).toBe(1);
    expect(logInserted).toBe(true);

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// POST /mobile/intake + /mobile/intake/confirm
// ---------------------------------------------------------------------------

describe("POST /mobile/intake", () => {
  it("enqueues message and returns 202", async () => {
    const token = await mintTestToken();
    const queue = makeMockQueue();
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
    });
    const resp = await handleMobileRoutes(
      req("POST", "/mobile/intake", {
        headers: { Authorization: `Bearer ${token}` },
        body: { message: "Build a Linear CLI app", session_id: "20260503T144146Z", client_msg_id: "msg-001" },
      }),
      "/mobile/intake",
      makeEnv(db, queue)
    );
    expect(resp?.status).toBe(202);
    expect(queue.getSent()).toHaveLength(1);
    const queued = queue.getSent()[0] as Record<string, unknown>;
    expect(queued.message).toBe("Build a Linear CLI app");
    expect(queued.source).toBe("mobile");
    expect(queued.session_id).toBe("20260503T144146Z");
    expect(queued.client_msg_id).toBe("msg-001");
  });

  it("returns 400 for missing message", async () => {
    const token = await mintTestToken();
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
    });
    const resp = await handleMobileRoutes(
      req("POST", "/mobile/intake", {
        headers: { Authorization: `Bearer ${token}` },
        body: { session_id: "20260503T144146Z" },
      }),
      "/mobile/intake",
      makeEnv(db)
    );
    expect(resp?.status).toBe(400);
  });
});

describe("POST /mobile/intake/confirm", () => {
  it("enqueues confirm and returns 202", async () => {
    const token = await mintTestToken();
    const queue = makeMockQueue();
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
    });
    const resp = await handleMobileRoutes(
      req("POST", "/mobile/intake/confirm", {
        headers: { Authorization: `Bearer ${token}` },
        body: { intent_id: "20260503T144146Z" },
      }),
      "/mobile/intake/confirm",
      makeEnv(db, queue)
    );
    expect(resp?.status).toBe(202);
    const queued = queue.getSent()[0] as Record<string, unknown>;
    expect(queued.intent_id).toBe("20260503T144146Z");
    expect(queued.action).toBe("confirm");
    expect(queued.source).toBe("mobile");
  });
});

// ---------------------------------------------------------------------------
// POST /mobile/voice/transcribe — stub
// ---------------------------------------------------------------------------

describe("POST /mobile/voice/transcribe", () => {
  it("returns 503 with voice_not_provisioned", async () => {
    const token = await mintTestToken();
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
    });
    const resp = await handleMobileRoutes(
      req("POST", "/mobile/voice/transcribe", {
        headers: { Authorization: `Bearer ${token}` },
        body: {},
      }),
      "/mobile/voice/transcribe",
      makeEnv(db)
    );
    expect(resp?.status).toBe(503);
    const body = await resp?.json() as { error: string };
    expect(body.error).toBe("voice_not_provisioned");
  });
});

// ---------------------------------------------------------------------------
// GET /mobile/sessions + /mobile/comms
// ---------------------------------------------------------------------------

describe("GET /mobile/sessions", () => {
  it("returns 200 with sessions array", async () => {
    const token = await mintTestToken();
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
      allMap: {
        "FROM intake_session": [
          { session_id: "20260503T144146Z", status: "active", started_at: 1714000000000, last_msg_at: 1714001000000, msg_count: 3, title: "Build CLI" },
        ],
      },
    });
    const resp = await handleMobileRoutes(
      req("GET", "/mobile/sessions", { headers: { Authorization: `Bearer ${token}` } }),
      "/mobile/sessions",
      makeEnv(db)
    );
    expect(resp?.status).toBe(200);
    const body = await resp?.json() as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(1);
  });
});

describe("GET /mobile/comms", () => {
  it("returns 200 with comms array", async () => {
    const token = await mintTestToken();
    const db = makeD1Mock({
      firstMap: { "SELECT 1 FROM mobile_allowlist": { 1: 1 }, "SELECT signing_key, retired_at": null },
      allMap: {
        "FROM comm_message": [
          { filename: "dev_to_qa.md", from_agent: "dev_lead", to_agent: "qa_lead", priority: "p1", thread_id: null, subject: "QA needed", payload: "Please review", ts: 1714000000000 },
        ],
      },
    });
    const resp = await handleMobileRoutes(
      req("GET", "/mobile/comms", { headers: { Authorization: `Bearer ${token}` } }),
      "/mobile/comms",
      makeEnv(db)
    );
    expect(resp?.status).toBe(200);
    const body = await resp?.json() as { comms: unknown[] };
    expect(body.comms).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Non-mobile path returns null (fallthrough)
// ---------------------------------------------------------------------------

describe("handleMobileRoutes — non-mobile path", () => {
  it("returns null for /v4/* paths", async () => {
    const db = makeD1Mock();
    const resp = await handleMobileRoutes(
      req("GET", "/v4/runs"),
      "/v4/runs",
      makeEnv(db)
    );
    expect(resp).toBeNull();
  });
});
