/**
 * auth-mode.ts — MOBILE_AUTH_MODE flag dispatcher.
 *
 * Single export: resolveMobileAuth(request, env) → AuthResult.
 *
 * Reads env.MOBILE_AUTH_MODE. If the literal string "founder":
 *   Returns a synthetic MobileJwtContext with sub="sai", provider="founder",
 *   device_id from X-Device-Id header (or "founder-default"), kid="founder".
 *   JWT verification and allowlist check are both bypassed (see ADR D-10).
 *
 * Any other value (including undefined / missing / "oauth") falls through to
 * the existing JWT path — fail-closed by spelling:
 *   if (env.MOBILE_AUTH_MODE === "founder")  ← NOT !==  "oauth"
 *
 * Trade-off: founder mode bypasses both JWT verification (defense layer 1)
 * and the mobile_allowlist check (defense layer 2). The TestFlight + Play
 * Internal invite lists are the sole identity boundary. Documented in ADR D-10.
 */

import { verifyAccessToken } from "./mobile-jwt";

// ---------------------------------------------------------------------------
// Types (shared with mobile-routes.ts via import)
// ---------------------------------------------------------------------------

export interface MobileJwtContext {
  sub:       string;
  provider:  "apple" | "google" | "founder";
  device_id: string;
  kid:       string;
}

export type AuthResult =
  | { ok: true;  ctx: MobileJwtContext }
  | { ok: false; response: Response };

// Minimal env shape required by this module; mobile-routes.ts extends this.
export interface AuthEnv {
  DASHBOARD_DB:           D1Database;
  MOBILE_JWT_SIGNING_KEY: string;
  MOBILE_AUTH_MODE?:      string;
}

// ---------------------------------------------------------------------------
// Internal — JWT + allowlist verification (oauth branch)
// ---------------------------------------------------------------------------

function jsonError(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function requireMobileJwt(
  request: Request,
  env: AuthEnv
): Promise<AuthResult> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, response: jsonError("missing_token", "Authorization: Bearer <token> required", 401) };
  }
  const token = auth.slice(7);
  const claims = await verifyAccessToken(token, env.DASHBOARD_DB, env.MOBILE_JWT_SIGNING_KEY);
  if (!claims) {
    return { ok: false, response: jsonError("invalid_token", "Token absent, expired, or invalid", 401) };
  }

  // Allowlist check: (provider, sub) tuple must exist in mobile_allowlist
  const allowRow = await env.DASHBOARD_DB
    .prepare("SELECT 1 FROM mobile_allowlist WHERE provider=? AND sub=?")
    .bind(claims.auth_provider, claims.sub)
    .first<{ 1: number }>();

  if (!allowRow) {
    return { ok: false, response: jsonError("not_allowed", "Identity not on allowlist", 403) };
  }

  return {
    ok: true,
    ctx: {
      sub:       claims.sub,
      provider:  claims.auth_provider,
      device_id: claims.device_id,
      kid:       claims.kid,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function resolveMobileAuth(
  request: Request,
  env: AuthEnv
): Promise<AuthResult> {
  if (env.MOBILE_AUTH_MODE === "founder") {
    const deviceId = request.headers.get("X-Device-Id") ?? "founder-default";
    return {
      ok: true,
      ctx: {
        sub:       "sai",
        provider:  "founder",
        device_id: deviceId,
        kid:       "founder",
      },
    };
  }

  // Any other value (oauth, missing, unknown) → existing JWT path (fail-closed)
  return requireMobileJwt(request, env);
}
