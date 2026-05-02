#!/usr/bin/env tsx
/**
 * bench_search.ts — /search p95 smoke benchmark (D-3 gate requirement).
 *
 * Runs 10 representative queries against a live Worker URL and reports p95 latency.
 * Gate: p95 < 350 ms. Exits 1 if gate fails.
 *
 * Usage:
 *   WORKER_URL=https://ingest.dashboard.saiteja.ai \
 *   CF_ACCESS_TOKEN=<jwt> \
 *   npx tsx scripts/bench_search.ts
 *
 * Or against wrangler dev:
 *   WORKER_URL=http://localhost:8787 \
 *   CF_ACCESS_TOKEN=test \
 *   npx tsx scripts/bench_search.ts
 */

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";
const CF_ACCESS_TOKEN = process.env.CF_ACCESS_TOKEN ?? "";
const P95_GATE_MS = 350;
const WARMUP_RUNS = 2;

// Representative queries covering different FTS5 corpus shapes
const QUERIES: Array<{ q: string; types?: string }> = [
  { q: "auth middleware" },
  { q: "SSRF" },
  { q: "FTS5 search" },
  { q: "deploy" },
  { q: "QA PASS" },
  { q: "pipeline build" },
  { q: "brainstorm dashboard" },
  { q: "decisions architect" },
  { q: "memory agent dev_lead" },
  { q: "intake classifier" },
];

async function runQuery(q: string, types?: string): Promise<number> {
  const params = new URLSearchParams({ q });
  if (types) params.set("types", types);
  params.set("limit", "20");

  const url = `${WORKER_URL}/search?${params.toString()}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (CF_ACCESS_TOKEN) {
    headers["Cf-Access-Jwt-Assertion"] = CF_ACCESS_TOKEN;
  }

  const start = performance.now();
  try {
    const resp = await fetch(url, { headers });
    const end = performance.now();
    if (!resp.ok && resp.status !== 200) {
      console.warn(`  [WARN] ${q}: HTTP ${resp.status}`);
    }
    return end - start;
  } catch (err) {
    const end = performance.now();
    console.warn(`  [WARN] ${q}: fetch error — ${(err as Error).message}`);
    return end - start;
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main() {
  console.log(`\nWorker: ${WORKER_URL}`);
  console.log(`Queries: ${QUERIES.length}, warmup: ${WARMUP_RUNS}\n`);

  // Warmup (not counted)
  for (let i = 0; i < WARMUP_RUNS; i++) {
    await runQuery("warmup");
  }

  const latencies: number[] = [];

  for (const { q, types } of QUERIES) {
    const ms = await runQuery(q, types);
    latencies.push(ms);
    console.log(`  ${q.padEnd(35)} ${ms.toFixed(1)} ms`);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];

  console.log(`\n── Results ────────────────────────────────`);
  console.log(`  p50: ${p50.toFixed(1)} ms`);
  console.log(`  p95: ${p95.toFixed(1)} ms  (gate: < ${P95_GATE_MS} ms)`);
  console.log(`  max: ${max.toFixed(1)} ms`);

  if (p95 >= P95_GATE_MS) {
    console.error(`\n✗ GATE FAILED: p95 ${p95.toFixed(1)} ms ≥ ${P95_GATE_MS} ms`);
    console.error(`  Fallback order per D-3:`);
    console.error(`    1. Drop snippets (title + permalink only)`);
    console.error(`    2. Drop FTS5 ranking on comms type`);
    console.error(`    3. Split into per-type endpoints (/search/runs, …)`);
    process.exit(1);
  }

  console.log(`\n✓ GATE PASSED: p95 ${p95.toFixed(1)} ms < ${P95_GATE_MS} ms`);
}

main();
