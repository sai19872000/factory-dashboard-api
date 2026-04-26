import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock jose before importing the worker
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue(() => Promise.resolve({})),
  jwtVerify: vi.fn(),
  errors: {
    JWTExpired: class extends Error { constructor(m: string) { super(m); this.name = "JWTExpired"; } },
    JWTInvalid: class extends Error { constructor(m: string) { super(m); this.name = "JWTInvalid"; } },
    JWTClaimValidationFailed: class extends Error { constructor(m: string) { super(m); this.name = "JWTClaimValidationFailed"; } },
    JOSEAlgNotAllowed: class extends Error { constructor(m: string) { super(m); this.name = "JOSEAlgNotAllowed"; } },
    JWKSNoMatchingKey: class extends Error { constructor(m: string) { super(m); this.name = "JWKSNoMatchingKey"; } },
  },
}));

import { jwtVerify } from "jose";
import worker, { Env } from "../src/index";

// ---- D1 mock ----
type D1StoredRow = { id: number; payload: string; content_hash: string; updated_at: number };

function makeD1() {
  let storedRow: D1StoredRow | null = null;
  const runSpy = vi.fn();

  function makePrepared(sql: string, boundArgs: unknown[] = []): D1PreparedStatement {
    return {
      bind(...args: unknown[]) {
        return makePrepared(sql, [...boundArgs, ...args]);
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        if (sql.toLowerCase().includes("select") && storedRow !== null) {
          return storedRow as unknown as T;
        }
        return null;
      },
      async run() {
        runSpy(sql, boundArgs);
        if (sql.toLowerCase().includes("insert into snapshot")) {
          storedRow = {
            id: 1,
            payload: boundArgs[0] as string,
            content_hash: boundArgs[1] as string,
            updated_at: boundArgs[2] as number,
          };
        }
        return { success: true, results: [], meta: { duration: 0, last_row_id: 1, changes: 1, changed_db: true, size_after: 0, rows_read: 0, rows_written: 1 } };
      },
      async all() {
        return { results: storedRow ? [storedRow] : [], success: true, meta: { duration: 0, last_row_id: 0, changes: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } };
      },
      async raw() {
        return [];
      },
    } as unknown as D1PreparedStatement;
  }

  return {
    prepare: (sql: string) => makePrepared(sql),
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
    // Test helpers
    _runSpy: runSpy,
    _seed(row: { payload: string; updated_at: number; content_hash?: string }) {
      storedRow = { id: 1, payload: row.payload, content_hash: row.content_hash ?? "", updated_at: row.updated_at };
    },
    _getRow: () => storedRow,
  } as unknown as D1Database & {
    _runSpy: ReturnType<typeof vi.fn>;
    _seed(row: { payload: string; updated_at: number; content_hash?: string }): void;
    _getRow(): D1StoredRow | null;
  };
}

// ---- Empty KV stub (FACTORY_DASHBOARD retained in Env for rollback safety — unused) ----
function makeEmptyKv(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

// ---- Valid snapshot fixture ----
function makeValidSnapshot(): Record<string, unknown> {
  const agentIds = [
    "orchestrator","intake","dev_lead","qa_lead","biz_lead","research_lead",
    "dev_backend","dev_frontend","data","ux","qa","security",
    "prospect_researcher","sales","marketing","risk","client",
    "market_researcher","market_watch","architect","devops","finance","critic",
  ];
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    daemon_id: "test-host",
    factory_root: "/home/sai/factory",
    agents: agentIds.map((id) => ({
      id, tier: 0, parent: null, state: "idle", current_runs: [], blocker_text: null,
    })),
    pipelines: { active: [], recent: [] },
    recent_comms: [],
    meta: { daemon_version: "abc1234", parse_warnings_count: 0 },
  };
}

function makeEnv(d1: D1Database): Env {
  return {
    DASHBOARD_DB: d1,
    FACTORY_DASHBOARD: makeEmptyKv(),
    INGEST_TOKEN: "valid-ingest-token-secret",
    CF_ACCESS_AUD_SNAPSHOT: "test-aud",
    CF_ACCESS_TEAM_DOMAIN: "testteam.cloudflareaccess.com",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// POST /ingest
// ============================================================================
describe("POST /ingest", () => {
  it("204 on valid snapshot with correct bearer — single D1 upsert", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const body = JSON.stringify(makeValidSnapshot());

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Snapshot-Version": "1",
        "Content-Length": String(body.length),
      },
      body,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    // Exactly one UPSERT run call
    expect((d1 as ReturnType<typeof makeD1>)._runSpy).toHaveBeenCalledTimes(1);
    const [calledSql] = (d1 as ReturnType<typeof makeD1>)._runSpy.mock.calls[0] as [string, unknown[]];
    expect(calledSql.toLowerCase()).toContain("insert into snapshot");
  });

  it("401 when bearer missing", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Snapshot-Version": "1",
      },
      body: JSON.stringify(makeValidSnapshot()),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    expect((d1 as ReturnType<typeof makeD1>)._runSpy).not.toHaveBeenCalled();
  });

  it("401 when bearer wrong", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": "Bearer wrong-token",
        "Content-Type": "application/json",
        "X-Snapshot-Version": "1",
      },
      body: JSON.stringify(makeValidSnapshot()),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("400 on wrong X-Snapshot-Version header", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Snapshot-Version": "2",
      },
      body: JSON.stringify(makeValidSnapshot()),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown snapshot version");
  });

  it("400 on snapshot with version: 2 in body", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const snap = { ...makeValidSnapshot(), version: 2 };

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Snapshot-Version": "1",
      },
      body: JSON.stringify(snap),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("415 on wrong Content-Type", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "text/plain",
        "X-Snapshot-Version": "1",
      },
      body: "not json",
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(415);
  });

  it("413 when body exceeds 256 KB", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const bigBody = "x".repeat(257 * 1024);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Snapshot-Version": "1",
        "Content-Length": String(bigBody.length),
      },
      body: bigBody,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
    expect((d1 as ReturnType<typeof makeD1>)._runSpy).not.toHaveBeenCalled();
  });

  it("does not include Authorization header value in error response", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const SECRET = "super-secret-token-should-not-leak";
    env.INGEST_TOKEN = SECRET;

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SECRET}`,
        "Content-Type": "text/plain", // will trigger 415
        "X-Snapshot-Version": "1",
      },
      body: "test",
    });

    const res = await worker.fetch(req, env);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
  });
});

// ============================================================================
// GET /snapshot
// ============================================================================
describe("GET /snapshot", () => {
  it("200 with snapshot data when CF Access JWT valid", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const snap = makeValidSnapshot();
    // Seed D1 store with merged envelope
    (d1 as ReturnType<typeof makeD1>)._seed({
      payload: JSON.stringify({
        snapshot: snap,
        meta: { last_push_at: new Date().toISOString(), daemon_id: "test-host", push_count: 1 },
      }),
      updated_at: Date.now(),
    });

    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt" },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json() as { version: number };
    expect(body.version).toBe(1);
  });

  it("GET /snapshot returns merged envelope with snapshot body and _meta block", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const snap = makeValidSnapshot();
    const meta = { last_push_at: "2026-04-26T07:00:00.000Z", daemon_id: "test-host", push_count: 7 };
    (d1 as ReturnType<typeof makeD1>)._seed({
      payload: JSON.stringify({ snapshot: snap, meta }),
      updated_at: Date.now(),
    });

    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt" },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { version: number; _meta: { push_count: number; daemon_id: string } };
    expect(body.version).toBe(1);
    expect(body._meta).toBeTruthy();
    expect(body._meta.push_count).toBe(7);
    expect(body._meta.daemon_id).toBe("test-host");
  });

  it("401 when CF Access JWT missing", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("404 when snapshot not in D1", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt" },
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
    const body = await res.json() as { asleep: boolean };
    expect(body.asleep).toBe(true);
  });
});

// ============================================================================
// GET /healthz
// ============================================================================
describe("GET /healthz", () => {
  it("200 with ok:true even when no snapshot exists", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    const req = new Request("https://ingest.dashboard.saiteja.ai/healthz");
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; push_count: number };
    expect(body.ok).toBe(true);
    expect(body.push_count).toBe(0);
  });

  it("returns age_s and push_count after ingest", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    // Seed D1 store: updated_at 5 seconds ago, meta inside envelope
    const updatedAt = Date.now() - 5000;
    const meta = {
      last_push_at: new Date(updatedAt).toISOString(),
      daemon_id: "test",
      push_count: 3,
    };
    (d1 as ReturnType<typeof makeD1>)._seed({
      payload: JSON.stringify({ snapshot: {}, meta }),
      updated_at: updatedAt,
    });

    const req = new Request("https://ingest.dashboard.saiteja.ai/healthz");
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { age_s: number; push_count: number };
    expect(body.push_count).toBe(3);
    expect(body.age_s).toBeGreaterThanOrEqual(4);
  });
});

// ============================================================================
// Unknown routes
// ============================================================================
describe("unknown routes", () => {
  it("returns 404 for unknown path", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    const req = new Request("https://ingest.dashboard.saiteja.ai/unknown");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// CORS — browser-initiated SPA → Worker reads
// (P1-3 from run 20260425_211229: SPA at dashboard.saiteja.ai fetches Worker
// with credentials:include — cross-origin requires Origin echo + Credentials.)
// ============================================================================
describe("CORS", () => {
  const ALLOWED_PROD = "https://dashboard.saiteja.ai";
  const ALLOWED_STAGING = "https://staging.dashboard-saiteja.pages.dev";
  const DISALLOWED = "https://evil.example.com";

  it("OPTIONS /snapshot from prod origin → 204 with Origin echo", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_PROD, "Access-Control-Request-Method": "GET" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_PROD);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("OPTIONS /snapshot from staging origin → 204 with Origin echo", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_STAGING, "Access-Control-Request-Method": "GET" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_STAGING);
  });

  it("OPTIONS /snapshot from disallowed origin → 204 with NO CORS headers", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      method: "OPTIONS",
      headers: { Origin: DISALLOWED, "Access-Control-Request-Method": "GET" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("GET /snapshot 200 carries CORS headers when Origin allowlisted", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    // Seed D1 store
    (d1 as ReturnType<typeof makeD1>)._seed({
      payload: JSON.stringify({
        snapshot: makeValidSnapshot(),
        meta: { last_push_at: new Date().toISOString(), daemon_id: "test-host", push_count: 1 },
      }),
      updated_at: Date.now(),
    });
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });
    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      headers: {
        "Cf-Access-Jwt-Assertion": "valid.jwt",
        Origin: ALLOWED_STAGING,
      },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_STAGING);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("GET /snapshot 401 does NOT carry CORS headers (JWT-before-CORS rule)", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    // No JWT header → 401
    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      headers: { Origin: ALLOWED_PROD },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("GET /healthz carries CORS headers when Origin allowlisted (browser audit ergonomics)", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const req = new Request("https://ingest.dashboard.saiteja.ai/healthz", {
      headers: { Origin: ALLOWED_PROD },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_PROD);
  });

  it("OPTIONS /ingest is NOT CORS-handled (daemon-only path, no preflight needed)", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_PROD },
    });
    const res = await worker.fetch(req, env);
    // Falls through to 404 — daemon does not need browser preflight
    expect(res.status).toBe(404);
  });
});
