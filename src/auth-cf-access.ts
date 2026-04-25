/**
 * CF Access JWT verification using `jose`.
 * - Fetches JWKS from https://<TEAM_DOMAIN>/cdn-cgi/access/certs
 * - Caches JWKS response for 1 hour (in-memory, per isolate)
 * - Verifies: algorithm (RS256/ES256 only), kid present, exp not expired,
 *   aud === CF_ACCESS_AUD_SNAPSHOT, iss matches team domain, email === allowlist
 * - Never logs JWT or token values
 */

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from "jose";

interface JwksCache {
  getKey: ReturnType<typeof createRemoteJWKSet>;
  fetchedAt: number;
}

// Module-level cache — lives for the lifetime of the Worker isolate
let jwksCache: JwksCache | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

/** @internal — for unit tests only; resets the JWKS cache */
export function _resetJwksCacheForTest(): void {
  jwksCache = null;
}

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const now = Date.now();

  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.getKey;
  }

  const certsUrl = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
  const getKey = createRemoteJWKSet(certsUrl);

  jwksCache = { getKey, fetchedAt: now };
  return getKey;
}

export type CfAccessResult =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403; reason: string };

export async function validateCfAccessJwt(
  request: Request,
  teamDomain: string,
  audSnapshot: string,
  allowedEmail: string
): Promise<CfAccessResult> {
  // Extract JWT from CF-Access-Jwt-Assertion header (CF Access sets this)
  // or Authorization: Bearer <jwt> as a fallback (for manual testing)
  const cfJwt =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    extractBearerToken(request);

  if (!cfJwt) {
    return { ok: false, status: 401, reason: "missing CF Access JWT" };
  }

  try {
    const getKey = getJwks(teamDomain);

    const { payload } = await jwtVerify(cfJwt, getKey, {
      audience: audSnapshot,
      issuer: `https://${teamDomain}`,
      algorithms: ["RS256", "ES256"],
      // jose checks exp automatically
    });

    const email = payload["email"];
    if (typeof email !== "string" || email.length === 0) {
      return { ok: false, status: 401, reason: "missing email claim" };
    }

    if (email !== allowedEmail) {
      return { ok: false, status: 403, reason: "email not on allowlist" };
    }

    return { ok: true, email };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, status: 401, reason: "token expired" };
    }
    if (
      err instanceof joseErrors.JWTInvalid ||
      err instanceof joseErrors.JWTClaimValidationFailed ||
      err instanceof joseErrors.JOSEAlgNotAllowed ||
      err instanceof joseErrors.JWKSNoMatchingKey
    ) {
      return { ok: false, status: 401, reason: "invalid token" };
    }
    // JWKS fetch failures, network errors — fail closed
    return { ok: false, status: 401, reason: "auth unavailable" };
  }
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7);
}
