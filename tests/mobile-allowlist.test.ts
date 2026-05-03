/**
 * mobile-allowlist.test.ts
 *
 * Tests the (provider, sub) tuple allowlist enforcement in mobile-routes.ts:
 *   - Apple sub passes when (apple, sub) in allowlist
 *   - Google sub passes when (google, sub) in allowlist
 *   - Cross-provider collision: (google, sub) in allowlist does NOT unlock (apple, sub)
 *   - Missing allowlist row → 403
 *   - Allowlist row with wrong provider → 403
 */

import { describe, it, expect } from "vitest";
import { handleMobileRoutes } from "../src/mobile-routes";
import { mintTokenPair } from "../src/mobile-jwt";

const TEST_KEY_B64     = btoa(String.fromCharCode(...new Array(32).fill(0)));
const TEST_PUSH_SECRET = "test-push-secret-abc123";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeD1Mock(opts: {
  allowlistRow?: { provider: string; sub: string } | null;
  kidRow?: null;
}): D1Database {
  const { allowlistRow = null } = opts;
  return {
    prepare: (sql: string) => {
      let boundArgs: unknown[] = [];
      const stmt = {
        bind: (...args: unknown[]) => {
          boundArgs = args;
          return stmt;
        },
        first: async () => {
          if (sql.includes("mobile_allowlist") && sql.includes("provider") && sql.includes("sub")) {
            // Match (provider, sub) from bind args
            const qProvider = String(boundArgs[0]);
            const qSub      = String(boundArgs[1]);
            if (
              allowlistRow &&
              allowlistRow.provider === qProvider &&
              allowlistRow.sub === qSub
            ) {
              return { 1: 1 }; // match
            }
            return null; // no match
          }
          // KID lookup — always null (use fallback key)
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => ({}),
      };
      return stmt;
    },
    batch: async (_stmts: unknown[]) => [],
  } as unknown as D1Database;
}

async function mintToken(sub: string, provider: "apple" | "google"): Promise<string> {
  const db = {
    prepare: (_sql: string) => ({
      bind:  (..._a: unknown[]) => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }),
      first: async () => null,
      all:   async () => ({ results: [] }),
      run:   async () => ({}),
    }),
    batch: async (_s: unknown[]) => [],
  } as unknown as D1Database;
  const { access_token } = await mintTokenPair(sub, provider, "dev-1", db, TEST_KEY_B64);
  return access_token;
}

function makeEnv(db: D1Database) {
  return {
    DASHBOARD_DB:           db,
    MOBILE_JWT_SIGNING_KEY: TEST_KEY_B64,
    MOBILE_PUSH_SECRET:     TEST_PUSH_SECRET,
    APPLE_CLIENT_ID:        "ai.saiteja.factorymobile",
    GOOGLE_CLIENT_ID:       "1234.apps.googleusercontent.com",
    MOBILE_INTAKE_QUEUE:    { send: async () => {} } as unknown as Queue,
  };
}

function makeRequest(method: string, path: string, token: string): Request {
  return new Request(`https://ingest.dashboard.saiteja.ai${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mobile allowlist — (provider, sub) tuple enforcement", () => {
  it("grants access when (apple, sub) is in allowlist", async () => {
    const sub = "apple_user_sai";
    const token = await mintToken(sub, "apple");
    const db = makeD1Mock({ allowlistRow: { provider: "apple", sub } });

    const resp = await handleMobileRoutes(
      makeRequest("GET", "/mobile/runs", token),
      "/mobile/runs",
      makeEnv(db)
    );
    // Should NOT be 401 or 403 — may be 200 or other non-auth error
    expect(resp?.status).not.toBe(401);
    expect(resp?.status).not.toBe(403);
  });

  it("grants access when (google, sub) is in allowlist", async () => {
    const sub = "google_user_sai";
    const token = await mintToken(sub, "google");
    const db = makeD1Mock({ allowlistRow: { provider: "google", sub } });

    const resp = await handleMobileRoutes(
      makeRequest("GET", "/mobile/runs", token),
      "/mobile/runs",
      makeEnv(db)
    );
    expect(resp?.status).not.toBe(401);
    expect(resp?.status).not.toBe(403);
  });

  it("denies when (google, sub) is in allowlist but token is from Apple with same sub", async () => {
    // Cross-provider collision: same sub value but different provider
    const sub = "collision_sub_12345";
    const appleToken = await mintToken(sub, "apple");
    // Only (google, sub) is in the allowlist — Apple token with same sub should NOT pass
    const db = makeD1Mock({ allowlistRow: { provider: "google", sub } });

    const resp = await handleMobileRoutes(
      makeRequest("GET", "/mobile/runs", appleToken),
      "/mobile/runs",
      makeEnv(db)
    );
    expect(resp?.status).toBe(403);
    const body = await resp?.json() as { error: string };
    expect(body.error).toBe("not_allowed");
  });

  it("denies when no allowlist row exists for (provider, sub)", async () => {
    const sub = "unknown_user_999";
    const token = await mintToken(sub, "apple");
    const db = makeD1Mock({ allowlistRow: null });

    const resp = await handleMobileRoutes(
      makeRequest("GET", "/mobile/runs", token),
      "/mobile/runs",
      makeEnv(db)
    );
    expect(resp?.status).toBe(403);
  });

  it("denies when allowlist has row for a different sub with same provider", async () => {
    const sub = "sai_real_sub";
    const token = await mintToken("attacker_sub", "apple");
    // allowlist has (apple, sai_real_sub) but not (apple, attacker_sub)
    const db = makeD1Mock({ allowlistRow: { provider: "apple", sub } });

    const resp = await handleMobileRoutes(
      makeRequest("GET", "/mobile/runs", token),
      "/mobile/runs",
      makeEnv(db)
    );
    expect(resp?.status).toBe(403);
  });
});
