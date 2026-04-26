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

// ---- KV mock ----
function makeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const val = store.get(key) ?? null;
      if (val === null) return null;
      if (type === "json") return JSON.parse(val);
      return val;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }),
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

function makeEnv(kv: KVNamespace): Env {
  return {
    FACTORY_DASHBOARD: kv,
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
  it("204 on valid snapshot with correct bearer", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
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
    expect(kv.put).toHaveBeenCalled();
  });

  it("401 when bearer missing", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);

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
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("401 when bearer wrong", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);

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
    const kv = makeKv();
    const env = makeEnv(kv);

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
    const kv = makeKv();
    const env = makeEnv(kv);
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
    const kv = makeKv();
    const env = makeEnv(kv);

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
    const kv = makeKv();
    const env = makeEnv(kv);
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
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("does not include Authorization header value in error response", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
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
    const kv = makeKv();
    const env = makeEnv(kv);
    const snap = makeValidSnapshot();
    await kv.put("factory:snapshot:current", JSON.stringify(snap));

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

  it("401 when CF Access JWT missing", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);

    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("404 when snapshot expired (not in KV)", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);

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
    const kv = makeKv();
    const env = makeEnv(kv);

    const req = new Request("https://ingest.dashboard.saiteja.ai/healthz");
    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; push_count: number };
    expect(body.ok).toBe(true);
    expect(body.push_count).toBe(0);
  });

  it("returns age_s and push_count after ingest", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);

    // Manually write meta as ingest would
    const meta = {
      last_push_at: new Date(Date.now() - 5000).toISOString(),
      daemon_id: "test",
      push_count: 3,
    };
    await kv.put("factory:snapshot:meta", JSON.stringify(meta));

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
    const kv = makeKv();
    const env = makeEnv(kv);

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
    const kv = makeKv();
    const env = makeEnv(kv);
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
    const kv = makeKv();
    const env = makeEnv(kv);
    const req = new Request("https://ingest.dashboard.saiteja.ai/snapshot", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_STAGING, "Access-Control-Request-Method": "GET" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_STAGING);
  });

  it("OPTIONS /snapshot from disallowed origin → 204 with NO CORS headers", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
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
    const kv = makeKv();
    const env = makeEnv(kv);
    await kv.put("factory:snapshot:current", JSON.stringify(makeValidSnapshot()));
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
    const kv = makeKv();
    const env = makeEnv(kv);
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
    const kv = makeKv();
    const env = makeEnv(kv);
    const req = new Request("https://ingest.dashboard.saiteja.ai/healthz", {
      headers: { Origin: ALLOWED_PROD },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_PROD);
  });

  it("OPTIONS /ingest is NOT CORS-handled (daemon-only path, no preflight needed)", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    const req = new Request("https://ingest.dashboard.saiteja.ai/ingest", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_PROD },
    });
    const res = await worker.fetch(req, env);
    // Falls through to 404 — daemon does not need browser preflight
    expect(res.status).toBe(404);
  });
});
