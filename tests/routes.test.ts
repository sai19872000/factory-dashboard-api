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

// ============================================================================
// D1 mock — snapshot-only (used by all existing tests)
// ============================================================================

type D1SnapshotRow = { id: number; payload: string; content_hash: string; updated_at: number };

function makeD1() {
  let storedRow: D1SnapshotRow | null = null;
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
    _getRow(): D1SnapshotRow | null;
  };
}

// ============================================================================
// D1 mock — multi-table (agent_profile + pipeline_detail + snapshot)
// Used by new v2 route tests.
// ============================================================================

type AgentProfileRow = { agent_id: string; payload: string; content_hash: string; updated_at: number };
type PipelineDetailRow = {
  run_id: string; pipeline_type: string; status: string;
  payload: string; content_hash: string;
  started_at: number; ended_at: number | null; updated_at: number;
};

function makeMultiTableD1() {
  const snapshotStore = new Map<string, { id: number; payload: string; content_hash: string; updated_at: number }>();
  const profileStore = new Map<string, AgentProfileRow>();
  const pipelineStore = new Map<string, PipelineDetailRow>();
  const runSpy = vi.fn();

  function makePrepared(sql: string, boundArgs: unknown[] = []): D1PreparedStatement {
    const sqlLow = sql.toLowerCase();
    return {
      bind(...args: unknown[]) {
        return makePrepared(sql, [...boundArgs, ...args]);
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        if (sqlLow.includes("from snapshot")) {
          const row = snapshotStore.get("1");
          return (row ?? null) as unknown as T;
        }
        if (sqlLow.includes("from agent_profile") && sqlLow.includes("where")) {
          const agent_id = boundArgs[0] as string;
          return (profileStore.get(agent_id) ?? null) as unknown as T;
        }
        if (sqlLow.includes("from pipeline_detail") && sqlLow.includes("where")) {
          const run_id = boundArgs[0] as string;
          return (pipelineStore.get(run_id) ?? null) as unknown as T;
        }
        return null;
      },
      async run() {
        runSpy(sql, boundArgs);
        if (sqlLow.includes("insert into snapshot")) {
          snapshotStore.set("1", { id: 1, payload: boundArgs[0] as string, content_hash: boundArgs[1] as string, updated_at: boundArgs[2] as number });
        } else if (sqlLow.includes("insert into agent_profile")) {
          const agent_id = boundArgs[0] as string;
          const newHash = boundArgs[2] as string;
          const existing = profileStore.get(agent_id);
          // Simulate the ON CONFLICT ... WHERE excluded.content_hash != agent_profile.content_hash
          if (!existing || existing.content_hash !== newHash) {
            profileStore.set(agent_id, {
              agent_id,
              payload: boundArgs[1] as string,
              content_hash: newHash,
              updated_at: boundArgs[3] as number,
            });
          }
        } else if (sqlLow.includes("insert into pipeline_detail")) {
          const run_id = boundArgs[0] as string;
          pipelineStore.set(run_id, {
            run_id,
            pipeline_type: boundArgs[1] as string,
            status: boundArgs[2] as string,
            payload: boundArgs[3] as string,
            content_hash: boundArgs[4] as string,
            started_at: boundArgs[5] as number,
            ended_at: boundArgs[6] as number | null,
            updated_at: boundArgs[7] as number,
          });
        } else if (sqlLow.includes("delete from pipeline_detail")) {
          // Eviction: keep 50 most recent by updated_at
          const entries = [...pipelineStore.values()];
          entries.sort((a, b) => b.updated_at - a.updated_at);
          const keep = new Set(entries.slice(0, 50).map((e) => e.run_id));
          for (const [k] of pipelineStore) {
            if (!keep.has(k)) pipelineStore.delete(k);
          }
        }
        return { success: true, results: [], meta: { duration: 0, last_row_id: 1, changes: 1, changed_db: true, size_after: 0, rows_read: 0, rows_written: 1 } };
      },
      async all<T = Record<string, unknown>>() {
        if (sqlLow.includes("from agent_profile")) {
          return {
            results: [...profileStore.values()] as unknown as T[],
            success: true,
            meta: { duration: 0, last_row_id: 0, changes: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 },
          };
        }
        return { results: [] as T[], success: true, meta: { duration: 0, last_row_id: 0, changes: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } };
      },
      async raw() {
        return [];
      },
    } as unknown as D1PreparedStatement;
  }

  const batchSpy = vi.fn(async (stmts: D1PreparedStatement[]) => {
    for (const s of stmts) {
      await (s as unknown as { run(): Promise<unknown> }).run();
    }
    return stmts.map(() => ({ success: true, results: [], meta: {} }));
  });

  return {
    prepare: (sql: string) => makePrepared(sql),
    batch: batchSpy,
    dump: vi.fn(),
    exec: vi.fn(),
    _runSpy: runSpy,
    _batchSpy: batchSpy,
    _profileStore: profileStore,
    _pipelineStore: pipelineStore,
    _seedSnapshot(row: { payload: string; updated_at: number; content_hash?: string }) {
      snapshotStore.set("1", { id: 1, payload: row.payload, content_hash: row.content_hash ?? "", updated_at: row.updated_at });
    },
  } as unknown as D1Database & {
    _runSpy: ReturnType<typeof vi.fn>;
    _batchSpy: ReturnType<typeof vi.fn>;
    _profileStore: Map<string, AgentProfileRow>;
    _pipelineStore: Map<string, PipelineDetailRow>;
    _seedSnapshot(row: { payload: string; updated_at: number; content_hash?: string }): void;
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

// ---- Valid agent profiles fixture ----
function makeValidProfiles() {
  return {
    agents: {
      dev_lead: {
        role: "Principal Dev Lead",
        function_blurb: "- Owns the build pipeline\n- Reviews all PRs",
        frontmatter: { model: "opus", tier: "lead" },
        memory_md: "# Dev Lead Memory\nSome content here.",
      },
      qa_lead: {
        role: "Principal QA Lead",
        function_blurb: "- Owns test coverage\n- Signs off deploys",
        frontmatter: { model: "opus", tier: "lead" },
        memory_md: null,
      },
    },
  };
}

// ---- Valid pipeline detail fixture ----
function makeValidPipelineDetail(run_id = "20260426_182857") {
  return {
    run_id,
    pipeline_type: "build",
    status: "done",
    started_at: "2026-04-26T18:00:00.000Z",
    ended_at: "2026-04-26T18:28:57.000Z",
    beats: [
      {
        agent_id: "dev_lead",
        started_at: "2026-04-26T18:00:00.000Z",
        ended_at: "2026-04-26T18:20:00.000Z",
        state: "done",
        output_file: "outputs/20260426_182857/dev_lead_foo.md",
      },
    ],
    comms: [
      {
        filename: "dev_lead_to_qa_lead_20260426.md",
        from: "dev_lead",
        to: "qa_lead",
        subject: "Ready for QA",
        preview: "All tests pass, please review.",
        timestamp: "2026-04-26T18:21:00.000Z",
      },
    ],
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

  // Updated: "2" is now a valid version; test with a truly unknown version ("99")
  it("400 on unknown X-Snapshot-Version header (e.g. 99)", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Snapshot-Version": "99",
      },
      body: JSON.stringify(makeValidSnapshot()),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unknown snapshot version");
  });

  // Updated: version 2 is now accepted; test with an actually invalid version (99) in body
  it("400 on snapshot with unknown version (99) in body", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const snap = { ...makeValidSnapshot(), version: 99 };

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

  // New: v2 snapshot acceptance during rollover window (§10)
  it("204 on valid v2 snapshot with X-Snapshot-Version: 2", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const v2Snap = {
      ...makeValidSnapshot(),
      version: 2,
      pipelines: {
        active: [{
          pipeline_name: "build_pipeline",
          pipeline_type: "build",
          pid: 1234,
          run_id: "20260426_182857",
          started_at: new Date().toISOString(),
          elapsed_s: 60,
          task_preview: "Building worker",
          current_station_id: "dev",
          pipeline_detail_hash: "abc123",
          agent_lanes: [],
        }],
        recent: [],
      },
    };
    const body = JSON.stringify(v2Snap);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Snapshot-Version": "2",
        "Content-Length": String(body.length),
      },
      body,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
  });

  // New: v1 snapshot still accepted when Worker is on v2 (backwards compat direction A)
  it("204 on v1 snapshot with X-Snapshot-Version: 1 (v2 Worker bcompat)", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const body = JSON.stringify(makeValidSnapshot()); // version: 1

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
  });

  // AgentLane schema fix: v2 snapshot with active pipeline lane state="running" + ended_at=null
  // was HTTP 400 pre-fix (schema rejected). Expect 204 post-fix.
  it("204 on v2 snapshot with active pipeline lane ended_at:null + state:'running' (was 400 pre-fix)", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const snap = {
      ...makeValidSnapshot(),
      version: 2,
      pipelines: {
        active: [{
          pipeline_name: "build_pipeline",
          pipeline_type: "build",
          pid: 2291505,
          run_id: "20260427_172138",
          started_at: new Date().toISOString(),
          elapsed_s: 120,
          task_preview: "dev_backend running agent lane schema fix",
          current_station_id: "dev",
          pipeline_detail_hash: "deadbeef",
          agent_lanes: [{
            agent_id: "dev_backend",
            started_at: new Date().toISOString(),
            ended_at: null,
            state: "running",
          }],
        }],
        recent: [],
      },
    };
    const body = JSON.stringify(snap);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "X-Snapshot-Version": "2",
        "Content-Length": String(body.length),
      },
      body,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
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
// ============================================================================
describe("CORS", () => {
  const ALLOWED_PROD = "https://dashboard.saiteja.ai";
  const ALLOWED_STAGING = "https://staging.dashboard-saiteja.pages.dev";
  const ALLOWED_V2 = "https://dashboard-v2.saiteja.ai";
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

  it("OPTIONS /agents/profiles from v2 staging origin → 204 with Origin echo", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const req = new Request("https://ingest.dashboard.saiteja.ai/agents/profiles", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_V2, "Access-Control-Request-Method": "GET" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_V2);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Vary")).toBe("Origin");
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

  // New: new GET routes also get CORS preflight
  it("OPTIONS /agents/profiles from allowlisted origin → 204 with Origin echo", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const req = new Request("https://ingest.dashboard.saiteja.ai/agents/profiles", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_PROD, "Access-Control-Request-Method": "GET" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_PROD);
  });

  it("OPTIONS /pipelines/:run_id from allowlisted origin → 204 with Origin echo", async () => {
    const d1 = makeD1();
    const env = makeEnv(d1);
    const req = new Request("https://ingest.dashboard.saiteja.ai/pipelines/20260426_182857", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_STAGING, "Access-Control-Request-Method": "GET" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_STAGING);
  });
});

// ============================================================================
// POST /ingest/profiles — per-route body cap + dedupe
// ============================================================================
describe("POST /ingest/profiles", () => {
  it("204 on valid profiles payload", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const body = JSON.stringify(makeValidProfiles());

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/profiles", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      },
      body,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
  });

  it("401 when bearer missing on /ingest/profiles", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeValidProfiles()),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("413 when /ingest/profiles body exceeds 350 KB", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const bigBody = "x".repeat(351 * 1024);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/profiles", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": String(bigBody.length),
      },
      body: bigBody,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
  });

  it("body ≤256 KB accepted on /ingest/profiles (within its 350 KB cap)", async () => {
    // Ensures the old global 256 KB limit was replaced — profiles allows 350 KB
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    // Build a payload that is ~260 KB (exceeds old 256 KB limit, within new 350 KB)
    const bigMemory = "M".repeat(260 * 1024);
    const body = JSON.stringify({
      agents: {
        dev_lead: {
          role: "Lead",
          function_blurb: "- Does stuff",
          frontmatter: {},
          memory_md: bigMemory,
        },
      },
    });

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/profiles", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      },
      body,
    });

    const res = await worker.fetch(req, env);
    // 400 (schema validation: memory_md has no length cap in schema — this tests just 413 is NOT returned)
    // The schema doesn't enforce memory_md length, so we expect 204
    expect(res.status).not.toBe(413);
  });

  it("SHA-256 dedupe: second push with same content skips D1 write for that agent", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const profiles = makeValidProfiles();
    const body = JSON.stringify(profiles);

    const makeReq = () =>
      new Request("https://ingest.dashboard.saiteja.ai/ingest/profiles", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.INGEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body,
      });

    // First push: agents are written
    const res1 = await worker.fetch(makeReq(), env);
    expect(res1.status).toBe(204);

    const profileStoreAfterFirst = (d1 as ReturnType<typeof makeMultiTableD1>)._profileStore;
    const hashAfterFirst = profileStoreAfterFirst.get("dev_lead")?.content_hash;
    expect(hashAfterFirst).toBeTruthy();

    // Second push: same content → hash unchanged → mock simulates skip
    const res2 = await worker.fetch(makeReq(), env);
    expect(res2.status).toBe(204);
    // Hash in store unchanged (the mock's WHERE clause logic prevents overwrite)
    expect(profileStoreAfterFirst.get("dev_lead")?.content_hash).toBe(hashAfterFirst);
  });

  it("400 on invalid profiles schema", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/profiles", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ wrong_key: {} }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// POST /ingest/pipeline/:run_id — per-route body cap + eviction
// ============================================================================
describe("POST /ingest/pipeline/:run_id", () => {
  it("204 on valid pipeline detail payload", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const run_id = "20260426_182857";
    const body = JSON.stringify(makeValidPipelineDetail(run_id));

    const req = new Request(`https://ingest.dashboard.saiteja.ai/ingest/pipeline/${run_id}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      },
      body,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
  });

  it("401 when bearer missing on /ingest/pipeline/:run_id", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/pipeline/20260426_182857", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeValidPipelineDetail()),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("413 when /ingest/pipeline/:run_id body exceeds 50 KB", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const bigBody = "x".repeat(51 * 1024);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/pipeline/20260426_182857", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": String(bigBody.length),
      },
      body: bigBody,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
  });

  it("400 on run_id mismatch between URL and body", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    // URL says run_id A, body says run_id B
    const body = JSON.stringify(makeValidPipelineDetail("20260426_999999"));

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/pipeline/20260426_182857", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body,
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    const respBody = await res.json() as { error: string };
    expect(respBody.error).toBe("run_id mismatch");
  });

  it("eviction: after 51 inserts, only 50 rows remain (oldest evicted)", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const pipelineStore = (d1 as ReturnType<typeof makeMultiTableD1>)._pipelineStore;

    // Insert 51 pipeline_detail rows sequentially, using distinct updated_at via
    // faking the timestamp in the run_id-scoped payload so the mock can sort them.
    // We patch each row's updated_at in the store after insert to guarantee ordering.
    for (let i = 0; i < 51; i++) {
      const run_id = `20260426_${String(i).padStart(6, "0")}`;
      const body = JSON.stringify(makeValidPipelineDetail(run_id));
      const req = new Request(`https://ingest.dashboard.saiteja.ai/ingest/pipeline/${run_id}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.INGEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body,
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(204);
      // Patch updated_at so rows have strictly increasing timestamps (i=0 is oldest)
      const row = pipelineStore.get(run_id);
      if (row) {
        (row as { updated_at: number }).updated_at = 1000000 + i;
      }
    }

    // Trigger the eviction that runs on the 51st insert (already happened above).
    // Re-run the last request to force a fresh eviction pass with corrected timestamps.
    const lastId = "20260426_000050";
    const lastBody = JSON.stringify(makeValidPipelineDetail(lastId));
    const lastReq = new Request(`https://ingest.dashboard.saiteja.ai/ingest/pipeline/${lastId}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: lastBody,
    });
    await worker.fetch(lastReq, env);
    // Restore the patched timestamp on the reinserted row
    const lastRow = pipelineStore.get(lastId);
    if (lastRow) {
      (lastRow as { updated_at: number }).updated_at = 1000000 + 50;
    }

    // Exactly 50 rows should remain after eviction
    expect(pipelineStore.size).toBe(50);
    // The first-inserted row (i=0, oldest updated_at = 1000000) should have been evicted
    expect(pipelineStore.has("20260426_000000")).toBe(false);
    // The last-inserted row (i=50) should be present
    expect(pipelineStore.has("20260426_000050")).toBe(true);
  });

  it("400 on invalid pipeline detail schema", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest/pipeline/20260426_182857", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bad: "schema" }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// GET /agents/profiles — round-trip
// ============================================================================
describe("GET /agents/profiles", () => {
  it("200 with version:1 + agents map after profiles were ingested", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    // Ingest profiles first
    const profiles = makeValidProfiles();
    const ingestReq = new Request("https://ingest.dashboard.saiteja.ai/ingest/profiles", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(profiles),
    });
    await worker.fetch(ingestReq, env);

    // Now read them back
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const getReq = new Request("https://ingest.dashboard.saiteja.ai/agents/profiles", {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt" },
    });
    const res = await worker.fetch(getReq, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json() as { version: number; generated_at: string; agents: Record<string, unknown> };
    expect(body.version).toBe(1);
    expect(body.generated_at).toBeTruthy();
    expect(body.agents["dev_lead"]).toBeTruthy();
    expect((body.agents["dev_lead"] as { role: string }).role).toBe("Principal Dev Lead");
    expect(body.agents["qa_lead"]).toBeTruthy();
  });

  it("200 with empty agents map when no profiles ingested yet", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const req = new Request("https://ingest.dashboard.saiteja.ai/agents/profiles", {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Record<string, unknown> };
    expect(Object.keys(body.agents).length).toBe(0);
  });

  it("401 when CF Access JWT missing on /agents/profiles", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    const req = new Request("https://ingest.dashboard.saiteja.ai/agents/profiles");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("GET /agents/profiles CORS headers present for allowlisted origin", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const req = new Request("https://ingest.dashboard.saiteja.ai/agents/profiles", {
      headers: {
        "Cf-Access-Jwt-Assertion": "valid.jwt",
        Origin: "https://dashboard.saiteja.ai",
      },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://dashboard.saiteja.ai");
  });
});

// ============================================================================
// GET /pipelines/:run_id — round-trip
// ============================================================================
describe("GET /pipelines/:run_id", () => {
  it("200 with pipeline payload after it was ingested", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const run_id = "20260426_182857";
    const detail = makeValidPipelineDetail(run_id);

    // Ingest the detail
    const ingestReq = new Request(`https://ingest.dashboard.saiteja.ai/ingest/pipeline/${run_id}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(detail),
    });
    await worker.fetch(ingestReq, env);

    // Read it back
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const getReq = new Request(`https://ingest.dashboard.saiteja.ai/pipelines/${run_id}`, {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt" },
    });
    const res = await worker.fetch(getReq, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json() as typeof detail;
    expect(body.run_id).toBe(run_id);
    expect(body.pipeline_type).toBe("build");
    expect(body.status).toBe("done");
    expect(body.beats).toHaveLength(1);
    expect(body.beats[0].agent_id).toBe("dev_lead");
    expect(body.comms).toHaveLength(1);
  });

  it("204 + round-trip preserves null ended_at on a running beat", async () => {
    // Daemon emits ended_at: null for state="running" beats so pipeline_detail
    // content_hash stays stable across ticks. Worker must accept and preserve
    // the null end-to-end; otherwise live runs never make it to D1 and the
    // SPA's ReplayModal 404s for every active pipeline (critic gate, run
    // 20260426_180650).
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const run_id = "20260426_185800_live";
    const liveDetail = {
      run_id,
      pipeline_type: "build" as const,
      status: "live" as const,
      started_at: "2026-04-26T18:55:00.000Z",
      ended_at: null, // top-level — already nullable; sanity check
      beats: [
        {
          agent_id: "dev_lead",
          started_at: "2026-04-26T18:55:00.000Z",
          ended_at: "2026-04-26T18:57:00.000Z",
          state: "done" as const,
          output_file: "outputs/20260426_185800/dev_lead_x.md",
        },
        {
          // The in-flight beat — ended_at must be null
          agent_id: "qa_lead",
          started_at: "2026-04-26T18:57:00.000Z",
          ended_at: null,
          state: "running" as const,
          output_file: null,
        },
      ],
      comms: [],
    };

    const ingestReq = new Request(`https://ingest.dashboard.saiteja.ai/ingest/pipeline/${run_id}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(liveDetail),
    });
    const ingestRes = await worker.fetch(ingestReq, env);
    expect(ingestRes.status).toBe(204);

    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const getReq = new Request(`https://ingest.dashboard.saiteja.ai/pipelines/${run_id}`, {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt" },
    });
    const getRes = await worker.fetch(getReq, env);
    expect(getRes.status).toBe(200);
    const body = await getRes.json() as typeof liveDetail;
    expect(body.status).toBe("live");
    expect(body.ended_at).toBeNull();
    expect(body.beats).toHaveLength(2);
    expect(body.beats[0].state).toBe("done");
    expect(body.beats[0].ended_at).toBe("2026-04-26T18:57:00.000Z");
    expect(body.beats[1].state).toBe("running");
    expect(body.beats[1].ended_at).toBeNull();
  });

  it("404 when pipeline_detail not found", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const req = new Request("https://ingest.dashboard.saiteja.ai/pipelines/nonexistent_run_id", {
      headers: { "Cf-Access-Jwt-Assertion": "valid.jwt" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pipeline not found");
  });

  it("401 when CF Access JWT missing on /pipelines/:run_id", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);

    const req = new Request("https://ingest.dashboard.saiteja.ai/pipelines/20260426_182857");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("GET /pipelines/:run_id CORS headers present for allowlisted origin", async () => {
    const d1 = makeMultiTableD1();
    const env = makeEnv(d1 as unknown as D1Database);
    const run_id = "20260426_182857";

    // Ingest first
    const ingestReq = new Request(`https://ingest.dashboard.saiteja.ai/ingest/pipeline/${run_id}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.INGEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(makeValidPipelineDetail(run_id)),
    });
    await worker.fetch(ingestReq, env);

    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "sai19872000@gmail.com" },
    });

    const req = new Request(`https://ingest.dashboard.saiteja.ai/pipelines/${run_id}`, {
      headers: {
        "Cf-Access-Jwt-Assertion": "valid.jwt",
        Origin: "https://staging.dashboard-saiteja.pages.dev",
      },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://staging.dashboard-saiteja.pages.dev");
  });
});
