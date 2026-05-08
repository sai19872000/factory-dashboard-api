/**
 * mobile-jwt.test.ts
 *
 * Tests:
 *   - mintTokenPair + verifyAccessToken happy path
 *   - Expired access token rejection
 *   - Malformed token rejection (bad sig, wrong parts, missing claims)
 *   - KID rotation: old kid still verifies until retired_at set
 *   - consumeRefreshToken happy path + single-use enforcement + expiry
 */

import { describe, it, expect } from "vitest";
import { mintTokenPair, verifyAccessToken, consumeRefreshToken } from "../src/mobile-jwt";

// ---------------------------------------------------------------------------
// Test key — base64 of 32 zero bytes (for testing only)
// ---------------------------------------------------------------------------
const TEST_KEY_B64 = btoa(String.fromCharCode(...new Array(32).fill(0)));

// ---------------------------------------------------------------------------
// D1 mock helpers
// ---------------------------------------------------------------------------

type Stmt = {
  first: () => Promise<unknown>;
  all:   () => Promise<{ results: unknown[] }>;
  run:   () => Promise<unknown>;
  bind:  (...args: unknown[]) => Stmt;
};

function makeStmt(firstVal: unknown = null, allVals: unknown[] = []): Stmt {
  const stmt: Stmt = {
    first:  async () => firstVal,
    all:    async () => ({ results: allVals }),
    run:    async () => ({}),
    bind:   (..._args: unknown[]) => stmt,
  };
  return stmt;
}

/** Build a D1 mock that routes by SQL pattern */
function makeD1(handlers: Record<string, unknown>): D1Database {
  return {
    prepare: (sql: string) => {
      // find a matching handler key (prefix match)
      for (const [key, val] of Object.entries(handlers)) {
        if (sql.includes(key)) {
          if (typeof val === "function") {
            return val(sql);
          }
          return makeStmt(val);
        }
      }
      return makeStmt();
    },
    batch: async (_stmts: unknown[]) => [],
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// mintTokenPair + verifyAccessToken
// ---------------------------------------------------------------------------

describe("mobile JWT — mint and verify", () => {
  it("mints an access token that verifies successfully", async () => {
    let refreshInserted = false;
    const db = makeD1({
      // getActiveKid — no row in D1 → falls back to TEST_KEY_B64
      "SELECT kid, signing_key FROM mobile_jwt_kid": null,
      // consumeRefreshToken — we don't consume in this test, but insert fires
      "INSERT INTO mobile_refresh_token": {
        bind: () => ({ run: async () => { refreshInserted = true; return {}; } }),
      },
    });

    const { access_token, refresh_token_id, refresh_secret } = await mintTokenPair(
      "apple_sub_123",
      "apple",
      "device_abc",
      db,
      TEST_KEY_B64
    );

    expect(typeof access_token).toBe("string");
    expect(access_token.split(".")).toHaveLength(3);
    expect(typeof refresh_token_id).toBe("string");
    expect(typeof refresh_secret).toBe("string");

    // Verify the access token
    const verifyDb = makeD1({
      // getKeyByKid for kid="default" → fallback path (no D1 lookup needed)
      "SELECT signing_key, retired_at FROM mobile_jwt_kid WHERE kid": null,
    });
    const claims = await verifyAccessToken(access_token, verifyDb, TEST_KEY_B64);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("apple_sub_123");
    expect(claims!.auth_provider).toBe("apple");
    expect(claims!.device_id).toBe("device_abc");
    expect(claims!.iss).toBe("factory-dashboard-api");
    expect(claims!.aud).toBe("factory-mobile");
    expect(claims!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a tampered access token", async () => {
    const db = makeD1({ "SELECT kid, signing_key FROM mobile_jwt_kid": null });
    const { access_token } = await mintTokenPair("sub", "google", "dev", db, TEST_KEY_B64);

    // Tamper with the signature
    const parts = access_token.split(".");
    parts[2] = parts[2].slice(0, -4) + "AAAA";
    const tampered = parts.join(".");

    const verifyDb = makeD1({ "SELECT signing_key, retired_at FROM mobile_jwt_kid WHERE kid": null });
    const claims = await verifyAccessToken(tampered, verifyDb, TEST_KEY_B64);
    expect(claims).toBeNull();
  });

  it("rejects an expired access token", async () => {
    // Manually construct an expired JWT using the same key
    const header = { alg: "HS256", typ: "JWT", kid: "default" };
    const payload = {
      iss: "factory-dashboard-api",
      aud: "factory-mobile",
      sub: "sub_expired",
      auth_provider: "apple",
      kid: "default",
      iat: Math.floor(Date.now() / 1000) - 3600,
      exp: Math.floor(Date.now() / 1000) - 1800, // expired 30 min ago
      device_id: "dev1",
    };

    // Build the token manually (duplicating the signing logic for test purposes)
    const enc = new TextEncoder();
    function b64url(bytes: Uint8Array): string {
      let b = "";
      for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
      return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    }
    const h = b64url(enc.encode(JSON.stringify(header)));
    const p = b64url(enc.encode(JSON.stringify(payload)));
    const keyBytes = Uint8Array.from(atob(TEST_KEY_B64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${h}.${p}`));
    const sigB64 = b64url(new Uint8Array(sig));
    const expiredToken = `${h}.${p}.${sigB64}`;

    const verifyDb = makeD1({ "SELECT signing_key, retired_at FROM mobile_jwt_kid WHERE kid": null });
    const claims = await verifyAccessToken(expiredToken, verifyDb, TEST_KEY_B64);
    expect(claims).toBeNull();
  });

  it("rejects a malformed token (2 parts)", async () => {
    const db = makeD1({ "SELECT signing_key, retired_at FROM mobile_jwt_kid WHERE kid": null });
    const result = await verifyAccessToken("header.payload", db, TEST_KEY_B64);
    expect(result).toBeNull();
  });

  it("rejects a token with a retired kid", async () => {
    // Mint with a real D1 KID row (not the "default" fallback) so getKeyByKid
    // goes through the D1 lookup path where retired_at is checked.
    const KEY2 = btoa(String.fromCharCode(...new Array(32).fill(2)));
    const dbWithKid = makeD1({
      "SELECT kid, signing_key FROM mobile_jwt_kid": {
        kid: "kid-retire-test",
        signing_key: KEY2,
        created_at: Date.now() - 5000,
        retired_at: null,
      },
    });
    const { access_token } = await mintTokenPair("sub", "apple", "dev", dbWithKid, TEST_KEY_B64);

    // Confirm the token was minted with the real kid (not "default")
    const hB64 = access_token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const hPad = hB64 + "=".repeat((4 - hB64.length % 4) % 4);
    const header = JSON.parse(atob(hPad)) as { kid: string };
    expect(header.kid).toBe("kid-retire-test");

    // Now verify with a DB that returns the same kid but retired_at set (non-null)
    const retiredDb = makeD1({
      "SELECT signing_key, retired_at FROM mobile_jwt_kid WHERE kid": {
        signing_key: KEY2,
        retired_at: Date.now() - 1000,
      },
    });
    const claims = await verifyAccessToken(access_token, retiredDb, TEST_KEY_B64);
    expect(claims).toBeNull();
  });

  it("KID rotation — old key still verifies when not yet retired", async () => {
    // Mint with "key1"
    const KEY1 = btoa(String.fromCharCode(...new Array(32).fill(1)));
    const dbKey1 = makeD1({
      "SELECT kid, signing_key FROM mobile_jwt_kid": {
        kid: "kid-1",
        signing_key: KEY1,
        created_at: Date.now() - 2000,
        retired_at: null,
      },
    });
    const { access_token } = await mintTokenPair("sub", "apple", "dev", dbKey1, TEST_KEY_B64);

    // Verify with a D1 that returns kid-1 as non-retired (active = true)
    const verifyDb = makeD1({
      "SELECT signing_key, retired_at FROM mobile_jwt_kid WHERE kid": {
        signing_key: KEY1,
        retired_at: null,
      },
    });
    const claims = await verifyAccessToken(access_token, verifyDb, TEST_KEY_B64);
    expect(claims).not.toBeNull();
    expect(claims!.kid).toBe("kid-1");
  });
});

// ---------------------------------------------------------------------------
// consumeRefreshToken
// ---------------------------------------------------------------------------

describe("mobile JWT — consumeRefreshToken", () => {
  it("consumes a valid refresh token successfully", async () => {
    // First, mint to get a real refresh token with a real hash
    let storedHash = "";
    let storedTokenId = "";
    let storedDeviceId = "";

    const mintDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first:  async () => null,
          all:    async () => ({ results: [] }),
          run:    async () => {
            if (sql.includes("INSERT INTO mobile_refresh_token")) {
              storedTokenId = String(args[0]);
              storedDeviceId = String(args[1]);
              storedHash = String(args[2]);
            }
            return {};
          },
        }),
        first:  async () => null,
        all:    async () => ({ results: [] }),
        run:    async () => ({}),
      }),
      batch: async (_stmts: unknown[]) => [],
    } as unknown as D1Database;

    const tokens = await mintTokenPair("sub", "apple", "device-x", mintDb, TEST_KEY_B64);
    expect(storedHash).toBeTruthy();
    expect(storedTokenId).toBe(tokens.refresh_token_id);
    expect(storedDeviceId).toBe("device-x");

    // Now consume it atomically (new implementation uses UPDATE … WHERE used=0 + meta.changes check)
    let atomicUpdateCalled = false;
    const consumeDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => {
            // New SELECT: WHERE token_id=? AND used=0 → returns row
            if (sql.includes("AND used=0")) {
              return { device_id: "device-x", secret_hash: storedHash, exp: Date.now() + 100_000 };
            }
            return null;
          },
          run: async () => {
            if (sql.includes("UPDATE mobile_refresh_token SET used=1")) {
              atomicUpdateCalled = true;
              return { meta: { changes: 1 } }; // 1 row changed = success
            }
            return { meta: { changes: 0 } };
          },
        }),
      }),
      batch: async (_stmts: unknown[]) => [],
    } as unknown as D1Database;

    const result = await consumeRefreshToken(tokens.refresh_token_id, tokens.refresh_secret, consumeDb);
    expect(result).not.toBeNull();
    expect(result!.device_id).toBe("device-x");
    expect(atomicUpdateCalled).toBe(true);
  });

  it("rejects an already-used refresh token — SELECT WHERE used=0 returns null", async () => {
    // When used=1, the query WHERE ... AND used=0 returns null → early exit
    const db = {
      prepare: (_sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => null, // used=0 filter means D1 returns nothing
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
      batch: async (_stmts: unknown[]) => [],
    } as unknown as D1Database;

    const result = await consumeRefreshToken("token-id", "some-secret", db);
    expect(result).toBeNull();
  });

  it("rejects an expired refresh token (row has past exp)", async () => {
    const db = {
      prepare: (_sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => ({
            device_id: "dev", secret_hash: "$pbkdf2-sha256$100000$aaaa$bbbb", exp: Date.now() - 1000,
          }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
      batch: async (_stmts: unknown[]) => [],
    } as unknown as D1Database;

    const result = await consumeRefreshToken("token-id", "some-secret", db);
    expect(result).toBeNull();
  });

  it("rejects a not-found refresh token", async () => {
    const db = {
      prepare: (_sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
      batch: async (_stmts: unknown[]) => [],
    } as unknown as D1Database;

    const result = await consumeRefreshToken("nonexistent", "secret", db);
    expect(result).toBeNull();
  });

  it("concurrent consume — second caller gets null (atomic UPDATE returns changes=0)", async () => {
    // Simulate: row exists and secret verifies, but UPDATE returns changes=0 (concurrent consume won)
    let capturedHash = "";
    const mintDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first:  async () => null,
          all:    async () => ({ results: [] }),
          run:    async () => {
            if (sql.includes("INSERT INTO mobile_refresh_token")) capturedHash = String(args[2]);
            return { meta: { changes: 1 } };
          },
        }),
        first: async () => null,
        all:   async () => ({ results: [] }),
        run:   async () => ({ meta: { changes: 1 } }),
      }),
      batch: async (_s: unknown[]) => [],
    } as unknown as D1Database;

    const { refresh_token_id, refresh_secret } = await mintTokenPair("sub", "apple", "dev", mintDb, TEST_KEY_B64);
    expect(capturedHash).toBeTruthy();

    // Race: row is found (used=0) but UPDATE returns changes=0
    const raceDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async () =>
            sql.includes("AND used=0")
              ? { device_id: "dev", secret_hash: capturedHash, exp: Date.now() + 100_000 }
              : null,
          run: async () => ({ meta: { changes: 0 } }), // concurrent consume already won
          all: async () => ({ results: [] }),
        }),
      }),
      batch: async (_s: unknown[]) => [],
    } as unknown as D1Database;

    const result = await consumeRefreshToken(refresh_token_id, refresh_secret, raceDb);
    expect(result).toBeNull();
  });
});
