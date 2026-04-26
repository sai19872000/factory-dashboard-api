import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock jose before importing auth module
vi.mock("jose", () => {
  return {
    createRemoteJWKSet: vi.fn(),
    jwtVerify: vi.fn(),
    errors: {
      JWTExpired: class JWTExpired extends Error {
        constructor(msg: string) { super(msg); this.name = "JWTExpired"; }
      },
      JWTInvalid: class JWTInvalid extends Error {
        constructor(msg: string) { super(msg); this.name = "JWTInvalid"; }
      },
      JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {
        constructor(msg: string) { super(msg); this.name = "JWTClaimValidationFailed"; }
      },
      JOSEAlgNotAllowed: class JOSEAlgNotAllowed extends Error {
        constructor(msg: string) { super(msg); this.name = "JOSEAlgNotAllowed"; }
      },
      JWKSNoMatchingKey: class JWKSNoMatchingKey extends Error {
        constructor(msg: string) { super(msg); this.name = "JWKSNoMatchingKey"; }
      },
    },
  };
});

import { createRemoteJWKSet, jwtVerify, errors } from "jose";
import { validateCfAccessJwt, _resetJwksCacheForTest } from "../src/auth-cf-access";

const TEAM_DOMAIN = "myteam.cloudflareaccess.com";
const AUD = "test-aud-value-123";
const ALLOWED_EMAIL = "sai19872000@gmail.com";

function makeRequest(jwt?: string): Request {
  const headers: Record<string, string> = {};
  if (jwt !== undefined) {
    headers["Cf-Access-Jwt-Assertion"] = jwt;
  }
  return new Request("https://ingest.dashboard.saiteja.ai/snapshot", { headers });
}

beforeEach(() => {
  vi.resetAllMocks();
  _resetJwksCacheForTest();
  (createRemoteJWKSet as ReturnType<typeof vi.fn>).mockReturnValue(() => Promise.resolve({}));
});

describe("validateCfAccessJwt", () => {
  it("valid JWT with correct email → ok: true", async () => {
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: ALLOWED_EMAIL, sub: "test" },
    });

    const req = makeRequest("valid.jwt.token");
    const result = await validateCfAccessJwt(req, TEAM_DOMAIN, AUD, ALLOWED_EMAIL);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.email).toBe(ALLOWED_EMAIL);
  });

  it("expired JWT → 401", async () => {
    (jwtVerify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      // @ts-expect-error jose mock constructor only needs message; payload arg not used in tests
      new errors.JWTExpired("token expired")
    );

    const req = makeRequest("expired.jwt.token");
    const result = await validateCfAccessJwt(req, TEAM_DOMAIN, AUD, ALLOWED_EMAIL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("wrong aud → 401 (JWTClaimValidationFailed)", async () => {
    (jwtVerify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      // @ts-expect-error jose mock constructor only needs message; claim/payload arg not used in tests
      new errors.JWTClaimValidationFailed("unexpected aud value")
    );

    const req = makeRequest("wrong.aud.token");
    const result = await validateCfAccessJwt(req, TEAM_DOMAIN, AUD, ALLOWED_EMAIL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("wrong email → 403", async () => {
    (jwtVerify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      payload: { email: "attacker@evil.com" },
    });

    const req = makeRequest("valid.jwt.wrong.email");
    const result = await validateCfAccessJwt(req, TEAM_DOMAIN, AUD, ALLOWED_EMAIL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("missing JWT header → 401", async () => {
    const req = makeRequest(undefined);
    const result = await validateCfAccessJwt(req, TEAM_DOMAIN, AUD, ALLOWED_EMAIL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("JWKS fetch failure → fails closed (401)", async () => {
    (jwtVerify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network error fetching JWKS")
    );

    const req = makeRequest("some.jwt.token");
    const result = await validateCfAccessJwt(req, TEAM_DOMAIN, AUD, ALLOWED_EMAIL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("no matching key in JWKS → 401", async () => {
    (jwtVerify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new errors.JWKSNoMatchingKey("no matching key")
    );

    const req = makeRequest("no.kid.token");
    const result = await validateCfAccessJwt(req, TEAM_DOMAIN, AUD, ALLOWED_EMAIL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});
