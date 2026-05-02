import { describe, it, expect } from "vitest";
import { buildHealthTarget, fetchHealth } from "../src/ssrf";

// ---------------------------------------------------------------------------
// buildHealthTarget — static rejection tests (no network)
// ---------------------------------------------------------------------------

describe("buildHealthTarget — SSRF rejection classes", () => {
  it("rejects null/undefined deploy_url", () => {
    const r1 = buildHealthTarget(null);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("deploy_url_missing");

    const r2 = buildHealthTarget(undefined);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("deploy_url_missing");
  });

  it("rejects malformed URL", () => {
    const r = buildHealthTarget("not a url at all $$");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("deploy_url_invalid");
  });

  it("rejects http:// (scheme != https)", () => {
    const r = buildHealthTarget("http://example.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme_not_https");
  });

  it("rejects IPv4 literal", () => {
    const cases = [
      "https://1.2.3.4/",
      "https://10.0.0.1/",
      "https://192.168.1.100/api",
      "https://127.0.0.1/",
      "https://169.254.169.254/latest",
    ];
    for (const url of cases) {
      const r = buildHealthTarget(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("ip_literal");
    }
  });

  it("rejects localhost and .local / .internal / .lan / .localhost suffixes", () => {
    const cases = [
      "https://localhost/",
      "https://foo.localhost/",
      "https://service.internal/",
      "https://db.local/",
      "https://router.lan/",
    ];
    for (const url of cases) {
      const r = buildHealthTarget(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("private_hostname");
    }
  });

  it("rejects IPv6 literals (contains ':')", () => {
    const r = buildHealthTarget("https://[::1]/");
    expect(r.ok).toBe(false);
    // URL parser strips brackets from hostname → hostname is "::1"
    if (!r.ok) expect(["ip_literal", "private_hostname"]).toContain(r.reason);
  });

  it("accepts a valid public https URL", () => {
    const r = buildHealthTarget("https://app.saiteja.ai/some/path?q=1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Path/query stripped; /healthz appended to origin
      expect(r.target).toBe("https://app.saiteja.ai/healthz");
    }
  });

  it("accepts https with port in URL", () => {
    const r = buildHealthTarget("https://app.example.com:8443/dashboard");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("https://app.example.com:8443/healthz");
    }
  });

  it("rejects private IPv4 in CIDR ranges", () => {
    const cases = [
      "https://172.16.0.1/",
      "https://172.31.255.255/",
      "https://10.10.20.30/",
    ];
    for (const url of cases) {
      const r = buildHealthTarget(url);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("ip_literal"); // IPv4 literal hits ip_literal first
    }
  });
});

// ---------------------------------------------------------------------------
// fetchHealth — redirect:manual behavior
// Uses global fetch mock provided by vitest environment (or msw in CI)
// For now we test the internal logic by mocking fetch
// ---------------------------------------------------------------------------

describe("fetchHealth — redirect handling", () => {
  it("returns ok:false with source_status for 3xx (does NOT follow redirect)", async () => {
    // Mock global fetch to return a 301
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(null, { status: 301, headers: { Location: "https://evil.com" } });

    const result = await fetchHealth("https://example.com/healthz");
    expect(result.ok).toBe(false);
    expect((result as { source_status: number }).source_status).toBe(301);

    globalThis.fetch = originalFetch;
  });

  it("returns ok:true for 200 response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });

    const result = await fetchHealth("https://example.com/healthz");
    expect(result.ok).toBe(true);
    expect((result as { source_status: number }).source_status).toBe(200);

    globalThis.fetch = originalFetch;
  });

  it("returns fetch_error on network failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network down"); };

    const result = await fetchHealth("https://example.com/healthz");
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("fetch_error");

    globalThis.fetch = originalFetch;
  });
});
