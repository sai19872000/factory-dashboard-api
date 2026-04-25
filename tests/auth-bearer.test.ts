import { describe, it, expect } from "vitest";
import { validateBearer } from "../src/auth-bearer";

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) {
    headers["Authorization"] = authHeader;
  }
  return new Request("https://example.com/ingest", {
    method: "POST",
    headers,
  });
}

const VALID_TOKEN = "test-token-abc123-secret-value-xyz";

describe("validateBearer", () => {
  it("accepts valid token → ok: true", () => {
    const req = makeRequest(`Bearer ${VALID_TOKEN}`);
    const result = validateBearer(req, VALID_TOKEN);
    expect(result.ok).toBe(true);
  });

  it("rejects missing Authorization header → 401", () => {
    const req = makeRequest(undefined);
    const result = validateBearer(req, VALID_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects wrong token → 401", () => {
    const req = makeRequest("Bearer wrong-token");
    const result = validateBearer(req, VALID_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects non-Bearer scheme → 401", () => {
    const req = makeRequest(`Token ${VALID_TOKEN}`);
    const result = validateBearer(req, VALID_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("timing-safe: returns same result for short and long wrong tokens", () => {
    const shortWrong = makeRequest("Bearer x");
    const longWrong = makeRequest("Bearer " + "x".repeat(200));

    const r1 = validateBearer(shortWrong, VALID_TOKEN);
    const r2 = validateBearer(longWrong, VALID_TOKEN);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });

  it("empty Bearer value → 401", () => {
    const req = makeRequest("Bearer ");
    const result = validateBearer(req, VALID_TOKEN);
    expect(result.ok).toBe(false);
  });
});
