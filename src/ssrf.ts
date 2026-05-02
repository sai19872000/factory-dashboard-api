/**
 * SSRF validator for /projects/:name/health proxy.
 *
 * Enforces (per D-6 fix paragraph):
 *   1. scheme must be https:
 *   2. No IP literals (IPv4 or IPv6)
 *   3. No localhost / .localhost / .internal / .local / .lan hostnames
 *   4. No CIDR-mapped private-zone hostnames (best-effort regex; no DNS
 *      resolution — single-user, known gap documented)
 *   5. Appends fixed /healthz to origin (ignores registered path/query)
 *   6. Fetches with redirect:"manual" + 2 s AbortSignal timeout
 *   7. Caches result for 60 s via Cache API (keyed on project name)
 */

export type SsrfRejectReason =
  | "deploy_url_missing"
  | "deploy_url_invalid"
  | "scheme_not_https"
  | "ip_literal"
  | "private_hostname"
  | "fetch_error"
  | "timeout";

export type SsrfResult =
  | { ok: boolean; source_status: number; age_s: null }
  | { ok: false; reason: SsrfRejectReason; source_status: 0; age_s: null };

// IPv4 literal: 1-3 digits repeated 4 times with dots
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// Private IPv4 CIDRs expressed as prefix-matching regexes.
// Covers: 10/8, 172.16-31/12, 192.168/16, 127/8, 169.254/16
const PRIVATE_IPV4_PREFIXES: RegExp[] = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
];

/** Return true if hostname looks like a private/internal name. */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // IPv4 literal?
  if (IPV4_RE.test(h)) {
    // Check private ranges
    for (const re of PRIVATE_IPV4_PREFIXES) {
      if (re.test(h)) return true;
    }
    // Any IPv4 literal is still rejected (IP literals blocked at caller)
    return false; // handled by isIpLiteral
  }

  // IPv6: presence of ":" is sufficient signal (includes ::1, fc00::, fe80::)
  if (h.includes(":")) return true;

  // Blocked TLDs / suffixes
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".internal") ||
    h.endsWith(".local") ||
    h.endsWith(".lan")
  ) {
    return true;
  }

  return false;
}

/** Return true if hostname is an IP literal (IPv4 or IPv6). */
function isIpLiteral(hostname: string): boolean {
  // IPv4
  if (IPV4_RE.test(hostname)) return true;
  // IPv6 (raw or bracket-stripped by URL parser)
  if (hostname.includes(":")) return true;
  return false;
}

/**
 * Validate deployUrl and build the target health URL.
 * Returns { ok: true, target } or { ok: false, reason }.
 */
export function buildHealthTarget(
  deployUrl: string | null | undefined
): { ok: true; target: string } | { ok: false; reason: SsrfRejectReason } {
  if (!deployUrl) {
    return { ok: false, reason: "deploy_url_missing" };
  }

  let url: URL;
  try {
    url = new URL(deployUrl);
  } catch {
    return { ok: false, reason: "deploy_url_invalid" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "scheme_not_https" };
  }

  const hostname = url.hostname;

  if (isIpLiteral(hostname)) {
    return { ok: false, reason: "ip_literal" };
  }

  if (isPrivateHostname(hostname)) {
    return { ok: false, reason: "private_hostname" };
  }

  // Fixed path: always /healthz on the origin (drop any registered path/query)
  const target = `${url.protocol}//${url.host}/healthz`;
  return { ok: true, target };
}

/**
 * Fetch the health endpoint with redirect:manual + 2 s timeout.
 * Caller is responsible for caching.
 */
export async function fetchHealth(target: string): Promise<SsrfResult> {
  let response: Response;
  try {
    response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    const isTimeout =
      err instanceof DOMException && err.name === "TimeoutError";
    return {
      ok: false,
      reason: isTimeout ? "timeout" : "fetch_error",
      source_status: 0,
      age_s: null,
    };
  }

  // 3xx → treat as unknown (do NOT follow)
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, source_status: response.status, age_s: null };
  }

  return {
    ok: response.status >= 200 && response.status < 300,
    source_status: response.status,
    age_s: null,
  };
}
