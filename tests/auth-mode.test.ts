/**
 * auth-mode.test.ts
 *
 * Tests for resolveMobileAuth (auth-mode.ts) — covers all 4 cells of the
 * Worker behavior table in ADR D-10:
 *   1. founder / no Authorization header  → synthetic ctx (ok)
 *   2. founder / Authorization header present → JWT ignored, synthetic ctx (ok)
 *   3. founder / X-Device-Id header present → device_id from header
 *   4. founder / X-Device-Id header absent  → device_id = "founder-default"
 *   5. oauth   / valid JWT                  → delegates to requireMobileJwt (ok)
 *   6. oauth   / invalid JWT                → 401
 *
 * Plus 1 integration test for GET /mobile/comms/threads (list) via handleMobileRoutes.
 */

import { describe, it, expect } from "vitest";
import { resolveMobileAuth } from "../src/auth-mode";
import { handleMobileRoutes } from "../src/mobile-routes";
import { mintTokenPair } from "../src/mobile-jwt";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_KEY_B64 = btoa(String.fromCharCode(...new Array(32).fill(0)));

function makeAuthEnv(mode?: string) {
  const db = {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first:  async () => {
          if (sql.includes("mobile_allowlist")) return { 1: 1 }; // allow all
          return null;
        },
        run:    async () => ({}),
        all:    async () => ({ results: [] }),
      }),
      first:  async () => null,
      all:    async () => ({ results: [] }),
      run:    async () => ({}),
    }),
    batch: async () => [],
  } as unknown as D1Database;

  return {
    DASHBOARD_DB:           db,
    MOBILE_JWT_SIGNING_KEY: TEST_KEY_B64,
    ...(mode !== undefined ? { MOBILE_AUTH_MODE: mode } : {}),
  };
}

async function mintTestJwt(sub = "test_sub") {
  const db = {
    prepare: () => ({
      bind: () => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({}),
    }),
    batch: async () => [],
  } as unknown as D1Database;
  const pair = await mintTokenPair(sub, "apple", "dev-1", db, TEST_KEY_B64);
  return pair.access_token;
}

function makeReq(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://example.com${path}`, { headers });
}

// ---------------------------------------------------------------------------
// resolveMobileAuth — founder mode
// ---------------------------------------------------------------------------

describe("resolveMobileAuth — founder mode", () => {
  it("returns synthetic ctx when no Authorization header present", async () => {
    const env = makeAuthEnv("founder");
    const result = await resolveMobileAuth(makeReq("/mobile/runs"), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ctx.sub).toBe("sai");
    expect(result.ctx.provider).toBe("founder");
    expect(result.ctx.kid).toBe("founder");
  });

  it("ignores Authorization header in founder mode — synthetic ctx returned", async () => {
    const token = await mintTestJwt("someone_else");
    const env = makeAuthEnv("founder");
    const result = await resolveMobileAuth(
      makeReq("/mobile/runs", { Authorization: `Bearer ${token}` }),
      env
    );
    // JWT ignored: sub is "sai", not "someone_else"
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ctx.sub).toBe("sai");
    expect(result.ctx.provider).toBe("founder");
  });

  it("captures X-Device-Id from header when present", async () => {
    const env = makeAuthEnv("founder");
    const result = await resolveMobileAuth(
      makeReq("/mobile/runs", { "X-Device-Id": "sai-iphone-uuid-123" }),
      env
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ctx.device_id).toBe("sai-iphone-uuid-123");
  });

  it("uses 'founder-default' when X-Device-Id header is absent", async () => {
    const env = makeAuthEnv("founder");
    const result = await resolveMobileAuth(makeReq("/mobile/runs"), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ctx.device_id).toBe("founder-default");
  });
});

// ---------------------------------------------------------------------------
// resolveMobileAuth — oauth mode (fallback path)
// ---------------------------------------------------------------------------

describe("resolveMobileAuth — oauth mode", () => {
  it("delegates to requireMobileJwt for a valid JWT — returns ok ctx", async () => {
    const token = await mintTestJwt("sai_apple_sub");
    const env = makeAuthEnv("oauth");
    const result = await resolveMobileAuth(
      makeReq("/mobile/runs", { Authorization: `Bearer ${token}` }),
      env
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ctx.sub).toBe("sai_apple_sub");
    expect(result.ctx.provider).toBe("apple");
  });

  it("rejects invalid/missing JWT when mode is oauth — returns 401", async () => {
    // No MOBILE_AUTH_MODE set → defaults to oauth path
    const env = makeAuthEnv(undefined);
    const result = await resolveMobileAuth(makeReq("/mobile/runs"), env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /mobile/comms/threads — list via handleMobileRoutes
// ---------------------------------------------------------------------------

describe("GET /mobile/comms/threads", () => {
  it("returns 200 with threads array in founder mode", async () => {
    const threads = [
      { thread_id: "thread-abc", subject: "Re: Deploy", priority: "p1", last_msg_ts: 1714000000000, msg_count: 3, last_sender: "qa_lead" },
    ];
    const db = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first:  async () => null,
          all:    async () => {
            if (sql.includes("comm_thread")) return { results: threads };
            return { results: [] };
          },
          run:    async () => ({}),
        }),
        first:  async () => null,
        all:    async () => ({ results: [] }),
        run:    async () => ({}),
      }),
      batch: async () => [],
    } as unknown as D1Database;

    const env = {
      DASHBOARD_DB:           db,
      MOBILE_JWT_SIGNING_KEY: TEST_KEY_B64,
      MOBILE_PUSH_SECRET:     "secret",
      APPLE_CLIENT_ID:        "client",
      GOOGLE_CLIENT_ID:       "gclient",
      MOBILE_INTAKE_QUEUE:    { send: async () => {} } as unknown as Queue,
      MOBILE_AUTH_MODE:       "founder",
    };

    const request = new Request("https://example.com/mobile/comms/threads");
    const resp = await handleMobileRoutes(request, "/mobile/comms/threads", env);
    expect(resp?.status).toBe(200);
    const body = await resp?.json() as { threads: unknown[] };
    expect(Array.isArray(body.threads)).toBe(true);
    expect((body.threads[0] as Record<string, unknown>).thread_id).toBe("thread-abc");
  });
});
