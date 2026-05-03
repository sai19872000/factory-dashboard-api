/**
 * mobile-jwks.ts — Apple + Google JWKS fetch, 24h cache, identity-token verification.
 *
 * Uses jose (already a project dependency) for RS256/ES256 verification via
 * createLocalJWKSet + jwtVerify. JWKS cached 24h in CF caches.default to avoid
 * repeated fetches across Worker invocations; falls back to a fresh fetch if
 * the cache is cold (new isolate, cache purge, or first deploy).
 *
 * Failure modes handled:
 *   - JWKS fetch failure → returns null (caller returns 503)
 *   - Wrong aud / iss / exp → returns null (caller returns 401)
 *   - Bad signature → returns null (caller returns 401)
 *   - Missing sub claim → returns null (caller returns 401)
 */

import { createLocalJWKSet, jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// JWKS endpoints
// ---------------------------------------------------------------------------

const APPLE_JWKS_URL  = "https://appleid.apple.com/auth/keys";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

const APPLE_ISSUER  = "https://appleid.apple.com";
const GOOGLE_ISSUER = "https://accounts.google.com";

const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h

// ---------------------------------------------------------------------------
// JWKS fetch with CF caches.default (24h)
// ---------------------------------------------------------------------------

interface JwksDoc {
  keys: unknown[];
}

async function fetchJwksWithCache(jwksUrl: string): Promise<JwksDoc> {
  const cacheKey = new Request(
    `https://mobile-jwks-cache.internal/${encodeURIComponent(jwksUrl)}`
  );
  const cache = caches.default;

  // Try cache first
  const cached = await cache.match(cacheKey);
  if (cached) {
    try {
      const data = await cached.json() as JwksDoc;
      if (Array.isArray(data.keys)) return data;
    } catch {
      // Cache entry corrupted — fall through to network fetch
    }
  }

  // Network fetch
  let resp: Response;
  try {
    resp = await fetch(jwksUrl, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0 }, // Disable CF's auto-cache; we manage it ourselves
    } as RequestInit);
  } catch {
    throw new Error(`JWKS network error: ${jwksUrl}`);
  }

  if (!resp.ok) {
    throw new Error(`JWKS fetch failed: ${resp.status} from ${jwksUrl}`);
  }

  let data: JwksDoc;
  try {
    data = await resp.json() as JwksDoc;
  } catch {
    throw new Error(`JWKS parse error: non-JSON response from ${jwksUrl}`);
  }

  if (!Array.isArray(data.keys)) {
    throw new Error(`JWKS shape error: missing keys array from ${jwksUrl}`);
  }

  // Store in cache with 24h TTL (fire-and-forget)
  const cacheResp = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
  cache.put(cacheKey, cacheResp); // intentionally not awaited

  return data;
}

// ---------------------------------------------------------------------------
// Shared verify helper
// ---------------------------------------------------------------------------

interface PlatformIdentityClaims {
  sub: string;
  email?: string;
}

async function verifyPlatformToken(
  token: string,
  jwksUrl: string,
  expectedIssuer: string,
  expectedAudience: string
): Promise<PlatformIdentityClaims | null> {
  let jwksDoc: JwksDoc;
  try {
    jwksDoc = await fetchJwksWithCache(jwksUrl);
  } catch {
    return null; // JWKS unreachable — caller returns 503
  }

  try {
    // createLocalJWKSet works on a static snapshot; handles kid matching internally
    const keySet = createLocalJWKSet(jwksDoc as Parameters<typeof createLocalJWKSet>[0]);

    const { payload } = await jwtVerify(token, keySet, {
      issuer:    expectedIssuer,
      audience:  expectedAudience,
      // jose validates exp automatically
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return null;
    }

    const result: PlatformIdentityClaims = { sub: payload.sub };
    if (typeof payload.email === "string") result.email = payload.email;
    return result;
  } catch {
    // Catches: JWTExpired, JWTInvalid, JWKSNoMatchingKey, JWTClaimValidationFailed, etc.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify an Apple identity token (returned by expo-apple-authentication).
 * Returns { sub } on success, null on any failure.
 * The `sub` claim is the stable Apple user identifier (does NOT change across
 * apps within the same Apple Developer Team; does change on team transfer —
 * devops runbook must cover this).
 */
export async function verifyAppleIdentityToken(
  token: string,
  appleClientId: string
): Promise<PlatformIdentityClaims | null> {
  return verifyPlatformToken(token, APPLE_JWKS_URL, APPLE_ISSUER, appleClientId);
}

/**
 * Verify a Google identity token (returned by @react-native-google-signin).
 * Returns { sub } on success, null on any failure.
 */
export async function verifyGoogleIdentityToken(
  token: string,
  googleClientId: string
): Promise<PlatformIdentityClaims | null> {
  return verifyPlatformToken(token, GOOGLE_JWKS_URL, GOOGLE_ISSUER, googleClientId);
}

/** @internal — for unit tests: inject a mock JWKS document. */
export async function _verifyTokenWithJwks(
  token: string,
  jwksDoc: JwksDoc,
  expectedIssuer: string,
  expectedAudience: string
): Promise<PlatformIdentityClaims | null> {
  try {
    const keySet = createLocalJWKSet(jwksDoc as Parameters<typeof createLocalJWKSet>[0]);
    const { payload } = await jwtVerify(token, keySet, {
      issuer:   expectedIssuer,
      audience: expectedAudience,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    const result: PlatformIdentityClaims = { sub: payload.sub };
    if (typeof payload.email === "string") result.email = payload.email;
    return result;
  } catch {
    return null;
  }
}
