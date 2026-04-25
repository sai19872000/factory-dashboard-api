/**
 * Constant-time bearer token comparison.
 * Never logs the token value.
 */

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);

  // If lengths differ, we still compare to avoid timing leaks on length,
  // but return false after. Compare against a fixed-length padded version.
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length; // non-zero if lengths differ

  for (let i = 0; i < len; i++) {
    const aByte = i < aBytes.length ? aBytes[i] : 0;
    const bByte = i < bBytes.length ? bBytes[i] : 0;
    diff |= aByte ^ bByte;
  }

  return diff === 0;
}

export function validateBearer(
  request: Request,
  expectedToken: string
): { ok: true } | { ok: false; status: 401 } {
  const authHeader = request.headers.get("Authorization") ?? "";

  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401 };
  }

  const provided = authHeader.slice(7); // strip "Bearer "

  if (!timingSafeEqual(provided, expectedToken)) {
    return { ok: false, status: 401 };
  }

  return { ok: true };
}
