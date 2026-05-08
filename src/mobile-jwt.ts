/**
 * mobile-jwt.ts — HS256 JWT mint + verify with KID-based rotation.
 *
 * Access tokens: 15 min, standard claims:
 *   { iss, aud, sub, auth_provider, kid, iat, exp, device_id }
 *
 * Refresh tokens: 30 day, opaque random IDs stored in D1 mobile_refresh_token.
 *   Secret is hashed via PBKDF2-SHA256 (100k iters + 16-byte random salt).
 *   Single-use: used flag set to 1 on consume; rotates on every use.
 *
 * KID rotation:
 *   Active key = mobile_jwt_kid WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1.
 *   Verify accepts any non-retired kid in D1.
 *   Falls back to MOBILE_JWT_SIGNING_KEY env var if no D1 kid row exists.
 *
 * Trade-off note: No native bcrypt in CF Workers. PBKDF2-SHA256 at 100k iters
 * provides ~equivalent brute-force resistance on random secrets. Refresh tokens
 * are 32-byte random values so offline dict attacks are infeasible regardless.
 *
 * Uses Web Crypto subtle.sign/verify per architect spec D-5.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccessTokenClaims {
  iss: "factory-dashboard-api";
  aud: "factory-mobile";
  sub: string;
  auth_provider: "apple" | "google";
  kid: string;
  iat: number;
  exp: number;
  device_id: string;
}

interface KidRow {
  kid: string;
  signing_key: string; // base64-encoded 32-byte key
  created_at: number;
  retired_at: number | null;
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const b64 = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Standard base64 (for D1-stored keys and PBKDF2 salts/hashes)
function b64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64Decode(str: string): Uint8Array {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 key import + sign/verify
// ---------------------------------------------------------------------------

async function importHmacKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signPayload(signingInput: string, key: CryptoKey): Promise<string> {
  const data = new TextEncoder().encode(signingInput);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return b64urlEncode(new Uint8Array(sig));
}

async function verifySignature(
  signingInput: string,
  sigB64url: string,
  key: CryptoKey
): Promise<boolean> {
  const data = new TextEncoder().encode(signingInput);
  const sig = b64urlDecode(sigB64url);
  return crypto.subtle.verify("HMAC", key, sig, data);
}

// ---------------------------------------------------------------------------
// JWT encode/decode (no external library — Web Crypto only)
// ---------------------------------------------------------------------------

function jwtEncode(header: object, payload: object, sig: string): string {
  const enc = new TextEncoder();
  const h = b64urlEncode(enc.encode(JSON.stringify(header)));
  const p = b64urlEncode(enc.encode(JSON.stringify(payload)));
  return `${h}.${p}.${sig}`;
}

function jwtSplit(token: string): [string, string, string] | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return [parts[0], parts[1], parts[2]];
}

function jwtDecodeHeader(headerB64url: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64url)));
  } catch {
    return null;
  }
}

function jwtDecodePayload(payloadB64url: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64url)));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// KID resolution
// ---------------------------------------------------------------------------

/** Get the active signing key. Reads D1; falls back to fallbackKey if empty. */
async function getActiveKid(
  db: D1Database,
  fallbackKey: string
): Promise<{ kid: string; keyBytes: Uint8Array }> {
  const row = await db
    .prepare(
      "SELECT kid, signing_key FROM mobile_jwt_kid WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1"
    )
    .first<{ kid: string; signing_key: string }>();

  if (row) {
    return { kid: row.kid, keyBytes: b64Decode(row.signing_key) };
  }

  // No KID row — use env var as the default key with a synthetic kid "default"
  return { kid: "default", keyBytes: b64Decode(fallbackKey) };
}

/** Fetch a non-retired key by kid. Returns null if kid not found or retired. */
async function getKeyByKid(
  db: D1Database,
  kid: string,
  fallbackKey: string
): Promise<Uint8Array | null> {
  if (kid === "default") {
    return b64Decode(fallbackKey);
  }
  const row = await db
    .prepare(
      "SELECT signing_key, retired_at FROM mobile_jwt_kid WHERE kid=?"
    )
    .bind(kid)
    .first<{ signing_key: string; retired_at: number | null }>();

  if (!row) return null;
  if (row.retired_at !== null) return null; // retired keys no longer verify
  return b64Decode(row.signing_key);
}

// ---------------------------------------------------------------------------
// PBKDF2 refresh-token secret hashing
// ---------------------------------------------------------------------------

const PBKDF2_ITERS = 100_000;
const PBKDF2_TAG   = "$pbkdf2-sha256";

/** Hash a 32-byte secret with a fresh random salt. Returns a stored string. */
async function hashRefreshSecret(secret: Uint8Array): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", secret, "PBKDF2", false, ["deriveBits"]
  );
  const hashBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERS },
    keyMaterial, 256
  );
  return `${PBKDF2_TAG}$${PBKDF2_ITERS}$${b64Encode(salt)}$${b64Encode(new Uint8Array(hashBuf))}`;
}

/** Verify a raw secret against a stored PBKDF2 hash. Timing-safe comparison. */
async function verifyRefreshSecret(
  secret: Uint8Array,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  // format: "" | "pbkdf2-sha256" | iters | saltB64 | hashB64 → 5 parts after split on "$"
  if (parts.length !== 5 || parts[1] !== "pbkdf2-sha256") return false;
  const iters = parseInt(parts[2], 10);
  if (isNaN(iters) || iters < 1) return false;
  const salt = b64Decode(parts[3]);
  const expected = b64Decode(parts[4]);

  const keyMaterial = await crypto.subtle.importKey(
    "raw", secret, "PBKDF2", false, ["deriveBits"]
  );
  const derivedBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iters },
    keyMaterial, 256
  );
  const derived = new Uint8Array(derivedBuf);

  // Timing-safe byte comparison
  let diff = derived.length ^ expected.length;
  const len = Math.max(derived.length, expected.length);
  for (let i = 0; i < len; i++) {
    diff |= (derived[i] ?? 0) ^ (expected[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Public API — mint
// ---------------------------------------------------------------------------

export interface TokenPair {
  access_token: string;
  refresh_token_id: string;
  /** Raw secret — returned once, never stored; client must hold securely. */
  refresh_secret: string;
}

/**
 * Mint an access + refresh token pair for a device.
 * Inserts a new mobile_refresh_token row.
 */
export async function mintTokenPair(
  sub: string,
  provider: "apple" | "google",
  deviceId: string,
  db: D1Database,
  fallbackKey: string
): Promise<TokenPair> {
  const now = Math.floor(Date.now() / 1000);
  const { kid, keyBytes } = await getActiveKid(db, fallbackKey);
  const key = await importHmacKey(keyBytes);

  // Access token (15 min)
  const header = { alg: "HS256", typ: "JWT", kid };
  const payload: AccessTokenClaims = {
    iss: "factory-dashboard-api",
    aud: "factory-mobile",
    sub,
    auth_provider: provider,
    kid,
    iat: now,
    exp: now + 15 * 60,
    device_id: deviceId,
  };
  const enc = new TextEncoder();
  const h = b64urlEncode(enc.encode(JSON.stringify(header)));
  const p = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await signPayload(`${h}.${p}`, key);
  const accessToken = jwtEncode(header, payload, sig);

  // Refresh token (30 days)
  const tokenId = crypto.randomUUID();
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  const secretHash = await hashRefreshSecret(secretBytes);
  const expMs = Date.now() + 30 * 24 * 60 * 60 * 1000;

  await db
    .prepare(
      "INSERT INTO mobile_refresh_token (token_id, device_id, secret_hash, exp, used) VALUES (?, ?, ?, ?, 0)"
    )
    .bind(tokenId, deviceId, secretHash, expMs)
    .run();

  const refreshSecret = b64urlEncode(secretBytes);
  return { access_token: accessToken, refresh_token_id: tokenId, refresh_secret: refreshSecret };
}

// ---------------------------------------------------------------------------
// Public API — verify access token
// ---------------------------------------------------------------------------

/**
 * Verify a mobile access token.
 * Returns the decoded claims on success, null on any failure
 * (malformed, expired, bad signature, unknown/retired kid).
 */
export async function verifyAccessToken(
  token: string,
  db: D1Database,
  fallbackKey: string
): Promise<AccessTokenClaims | null> {
  const parts = jwtSplit(token);
  if (!parts) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const header = jwtDecodeHeader(headerB64);
  if (!header || typeof header.kid !== "string") return null;
  if (header.alg !== "HS256") return null;
  const kid = header.kid;

  const keyBytes = await getKeyByKid(db, kid, fallbackKey);
  if (!keyBytes) return null;

  const key = await importHmacKey(keyBytes);
  const valid = await verifySignature(`${headerB64}.${payloadB64}`, sigB64, key);
  if (!valid) return null;

  const payload = jwtDecodePayload(payloadB64);
  if (!payload) return null;

  // Validate standard claims
  if (
    payload.iss !== "factory-dashboard-api" ||
    payload.aud !== "factory-mobile" ||
    typeof payload.sub !== "string" ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number" ||
    typeof payload.device_id !== "string" ||
    (payload.auth_provider !== "apple" && payload.auth_provider !== "google")
  ) {
    return null;
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;

  return payload as unknown as AccessTokenClaims;
}

// ---------------------------------------------------------------------------
// Public API — consume refresh token (single-use)
// ---------------------------------------------------------------------------

/**
 * Consume a refresh token. Marks it used=1 (single-use, atomic).
 * Returns the associated device_id on success, null on failure
 * (not found, already used, expired, bad secret, or concurrent consume).
 *
 * Atomicity: we verify the secret first (cheap early reject), then issue a
 * single UPDATE … WHERE used=0 AND exp > now. D1 returns meta.changes; if 0,
 * a concurrent request already consumed the token — we return null, preventing
 * TOCTOU double-spend.
 */
export async function consumeRefreshToken(
  tokenId: string,
  rawSecret: string,
  db: D1Database
): Promise<{ device_id: string } | null> {
  // Step 1: Read token metadata. Filter used=0 at the DB to get a quick null
  //         on already-consumed tokens without loading secret_hash unnecessarily.
  const row = await db
    .prepare(
      "SELECT device_id, secret_hash, exp FROM mobile_refresh_token WHERE token_id=? AND used=0"
    )
    .bind(tokenId)
    .first<{ device_id: string; secret_hash: string; exp: number }>();

  if (!row) return null;          // not found or already consumed
  if (row.exp < Date.now()) return null;      // expired

  // Step 2: Verify secret before consuming the slot (bad secrets don't burn
  //         the token; they just get rejected).
  const secretBytes = b64urlDecode(rawSecret);
  const ok = await verifyRefreshSecret(secretBytes, row.secret_hash);
  if (!ok) return null;

  // Step 3: Atomic consume — UPDATE only if still unused and not expired.
  //         meta.changes === 0 means a concurrent request already won the race.
  const result = await db
    .prepare(
      "UPDATE mobile_refresh_token SET used=1 WHERE token_id=? AND used=0 AND exp > ?"
    )
    .bind(tokenId, Date.now())
    .run();

  if ((result.meta.changes ?? 0) === 0) return null; // concurrent consume

  return { device_id: row.device_id };
}
