/**
 * mobile-jwks.test.ts
 *
 * Tests:
 *   - Verify Apple-shaped token with mock JWKS → success
 *   - Verify Google-shaped token with mock JWKS → success
 *   - Reject wrong aud
 *   - Reject wrong iss
 *   - Reject expired token
 *   - Reject bad signature (wrong key in JWKS)
 *
 * Uses _verifyTokenWithJwks to inject mock JWKS, avoiding real network calls.
 * The JWKS fixtures use ES256 with a test key (Web Crypto generateKey).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { _verifyTokenWithJwks } from "../src/mobile-jwks";

// ---------------------------------------------------------------------------
// Helpers: generate a real ES256 key pair + mint a platform-style identity token
// ---------------------------------------------------------------------------

interface TestKey {
  publicJwk: JsonWebKey;
  privateKey: CryptoKey;
  kid: string;
}

async function generateTestKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  ) as CryptoKeyPair;
  const rawJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = "test-kid-" + Math.random().toString(36).slice(2, 8);
  // CF workers-types defines JsonWebKey without kid/alg/use — cast via unknown
  const publicJwk = { ...(rawJwk as unknown as Record<string, unknown>), kid, alg: "ES256", use: "sig" } as unknown as JsonWebKey;
  return { publicJwk, privateKey: pair.privateKey, kid };
}

function b64url(bytes: Uint8Array): string {
  let b = "";
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function mintPlatformToken(opts: {
  privateKey: CryptoKey;
  kid: string;
  iss: string;
  aud: string;
  sub: string;
  expOffset?: number; // seconds from now (default +3600)
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expOffset = opts.expOffset ?? 3600;
  const enc = new TextEncoder();

  const header = { alg: "ES256", typ: "JWT", kid: opts.kid };
  const payload = {
    iss: opts.iss,
    aud: opts.aud,
    sub: opts.sub,
    iat: now,
    exp: now + expOffset,
    email: "sai@example.com",
  };

  const h = b64url(enc.encode(JSON.stringify(header)));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const signingInput = enc.encode(`${h}.${p}`);

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    opts.privateKey,
    signingInput
  );

  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let appleKey: TestKey;
let googleKey: TestKey;

beforeAll(async () => {
  appleKey  = await generateTestKey();
  googleKey = await generateTestKey();
});

function appleJwks() {
  return { keys: [appleKey.publicJwk] };
}

function googleJwks() {
  return { keys: [googleKey.publicJwk] };
}

const APPLE_ISS  = "https://appleid.apple.com";
const GOOGLE_ISS = "https://accounts.google.com";
const APPLE_AUD  = "ai.saiteja.factorymobile";
const GOOGLE_AUD = "1234567890-abc.apps.googleusercontent.com";

// ---------------------------------------------------------------------------
// Apple token tests
// ---------------------------------------------------------------------------

describe("mobile JWKS — Apple identity token", () => {
  it("verifies a valid Apple identity token", async () => {
    const token = await mintPlatformToken({
      privateKey: appleKey.privateKey,
      kid:        appleKey.kid,
      iss:        APPLE_ISS,
      aud:        APPLE_AUD,
      sub:        "apple_user_001",
    });

    const result = await _verifyTokenWithJwks(token, appleJwks(), APPLE_ISS, APPLE_AUD);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("apple_user_001");
    expect(result!.email).toBe("sai@example.com");
  });

  it("rejects Apple token with wrong aud", async () => {
    const token = await mintPlatformToken({
      privateKey: appleKey.privateKey,
      kid:        appleKey.kid,
      iss:        APPLE_ISS,
      aud:        "wrong.client.id",
      sub:        "apple_user_001",
    });

    const result = await _verifyTokenWithJwks(token, appleJwks(), APPLE_ISS, APPLE_AUD);
    expect(result).toBeNull();
  });

  it("rejects Apple token with wrong iss", async () => {
    const token = await mintPlatformToken({
      privateKey: appleKey.privateKey,
      kid:        appleKey.kid,
      iss:        "https://evil.example.com",
      aud:        APPLE_AUD,
      sub:        "apple_user_001",
    });

    const result = await _verifyTokenWithJwks(token, appleJwks(), APPLE_ISS, APPLE_AUD);
    expect(result).toBeNull();
  });

  it("rejects expired Apple token", async () => {
    const token = await mintPlatformToken({
      privateKey: appleKey.privateKey,
      kid:        appleKey.kid,
      iss:        APPLE_ISS,
      aud:        APPLE_AUD,
      sub:        "apple_user_001",
      expOffset:  -60, // expired 1 min ago
    });

    const result = await _verifyTokenWithJwks(token, appleJwks(), APPLE_ISS, APPLE_AUD);
    expect(result).toBeNull();
  });

  it("rejects Apple token signed with wrong key", async () => {
    const wrongKey = await generateTestKey();
    const token = await mintPlatformToken({
      privateKey: wrongKey.privateKey,
      kid:        appleKey.kid, // claims to be appleKey.kid but signed with wrongKey
      iss:        APPLE_ISS,
      aud:        APPLE_AUD,
      sub:        "apple_user_001",
    });

    // JWKS only contains appleKey.publicJwk — kid matches but sig won't verify
    const result = await _verifyTokenWithJwks(token, appleJwks(), APPLE_ISS, APPLE_AUD);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Google token tests
// ---------------------------------------------------------------------------

describe("mobile JWKS — Google identity token", () => {
  it("verifies a valid Google identity token", async () => {
    const token = await mintPlatformToken({
      privateKey: googleKey.privateKey,
      kid:        googleKey.kid,
      iss:        GOOGLE_ISS,
      aud:        GOOGLE_AUD,
      sub:        "google_user_999",
    });

    const result = await _verifyTokenWithJwks(token, googleJwks(), GOOGLE_ISS, GOOGLE_AUD);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("google_user_999");
  });

  it("rejects Google token with wrong aud", async () => {
    const token = await mintPlatformToken({
      privateKey: googleKey.privateKey,
      kid:        googleKey.kid,
      iss:        GOOGLE_ISS,
      aud:        "wrong-google-client",
      sub:        "google_user_999",
    });

    const result = await _verifyTokenWithJwks(token, googleJwks(), GOOGLE_ISS, GOOGLE_AUD);
    expect(result).toBeNull();
  });

  it("rejects Google token used against Apple JWKS (cross-provider)", async () => {
    // Mint a Google token then try to verify against Apple JWKS
    const token = await mintPlatformToken({
      privateKey: googleKey.privateKey,
      kid:        googleKey.kid,
      iss:        APPLE_ISS,   // wrong iss for Apple's verifier
      aud:        APPLE_AUD,
      sub:        "collision_attempt",
    });

    // Apple JWKS doesn't contain googleKey — JWKSNoMatchingKey
    const result = await _verifyTokenWithJwks(token, appleJwks(), APPLE_ISS, APPLE_AUD);
    expect(result).toBeNull();
  });
});
