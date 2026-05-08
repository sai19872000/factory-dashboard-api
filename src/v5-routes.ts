/**
 * v5 Memory Section route handlers.
 *
 * INGEST endpoints (bearer auth, body-capped):
 *   POST /ingest/skills            (256 KB)
 *   POST /ingest/playbooks         (256 KB, max 100 items)
 *   POST /ingest/project-memories  (512 KB, max 50 items)
 *
 * READ endpoints (CF Access JWT-auth):
 *   GET  /skills
 *   GET  /skills/:name
 *   GET  /playbooks
 *   GET  /playbooks/:scope/:owner/:slug
 *   GET  /project-memories
 *   GET  /project-memories/:slug
 */

import { validateBearer } from "./auth-bearer";
import { validateCfAccessJwt } from "./auth-cf-access";
import {
  IngestSkillsSchema,
  IngestPlaybooksSchema,
  IngestProjectMemoriesSchema,
  PlaybooksQuerySchema,
  ProjectMemoriesQuerySchema,
} from "./v5-schema";

// ---------------------------------------------------------------------------
// Env interface (mirrors V3Env — same bindings, new file to avoid circular dep)
// ---------------------------------------------------------------------------

export interface V5Env {
  DASHBOARD_DB:          D1Database;
  INGEST_TOKEN:          string;
  CF_ACCESS_AUD_SNAPSHOT: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  ALLOWED_EMAIL?:        string;
}

// ---------------------------------------------------------------------------
// Body size limits
// ---------------------------------------------------------------------------

const LIMIT_SKILLS           = 256 * 1024;
const LIMIT_PLAYBOOKS        = 256 * 1024;
const LIMIT_PROJECT_MEMORIES = 512 * 1024;

const ALLOWED_EMAIL_DEFAULT = "sai19872000@gmail.com";

// ---------------------------------------------------------------------------
// Shared helpers (mirror v3-routes.ts — no import to avoid circular dep)
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function readBodyCapped(
  request: Request,
  limitBytes: number,
  label: string
): Promise<{ ok: true; rawBody: string } | { ok: false; response: Response }> {
  const cl = request.headers.get("Content-Length");
  if (cl !== null && parseInt(cl, 10) > limitBytes) {
    return { ok: false, response: json({ error: `body exceeds ${label}` }, 413) };
  }
  let buf: ArrayBuffer;
  try {
    buf = await request.arrayBuffer();
  } catch {
    return { ok: false, response: json({ error: "failed to read body" }, 400) };
  }
  if (buf.byteLength > limitBytes) {
    return { ok: false, response: json({ error: `body exceeds ${label}` }, 413) };
  }
  return { ok: true, rawBody: new TextDecoder().decode(buf) };
}

async function requireBearer(request: Request, token: string): Promise<Response | null> {
  const r = validateBearer(request, token);
  if (!r.ok) return new Response(null, { status: 401 });
  return null;
}

async function requireCfAccess(request: Request, env: V5Env): Promise<Response | null> {
  const email = env.ALLOWED_EMAIL ?? ALLOWED_EMAIL_DEFAULT;
  const result = await validateCfAccessJwt(
    request,
    env.CF_ACCESS_TEAM_DOMAIN,
    env.CF_ACCESS_AUD_SNAPSHOT,
    email
  );
  if (!result.ok) return new Response(null, { status: result.status });
  return null;
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Extract description from frontmatter record (best-effort)
function extractDescription(frontmatter: Record<string, unknown> | null | undefined): string | null {
  if (!frontmatter) return null;
  const d = frontmatter["description"];
  return typeof d === "string" ? d : null;
}

// ---------------------------------------------------------------------------
// INGEST — POST /ingest/skills
// ---------------------------------------------------------------------------

export async function handleIngestSkills(request: Request, env: V5Env): Promise<Response> {
  const authErr = await requireBearer(request, env.INGEST_TOKEN);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_SKILLS, "256 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schema = IngestSkillsSchema.safeParse(parsed);
  if (!schema.success) return json({ error: "invalid skills schema" }, 400);

  const { skills } = schema.data;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  for (const [name, file] of Object.entries(skills)) {
    const hash = await sha256Hex(file.content);
    const description = extractDescription(file.frontmatter ?? null);
    const parsedJson = file.frontmatter ? JSON.stringify(file.frontmatter) : null;

    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT INTO skill_file (name, description, payload, parsed_json, content_hash, updated_at)" +
        " VALUES (?,?,?,?,?,?)" +
        " ON CONFLICT(name) DO UPDATE SET" +
        "  description=excluded.description, payload=excluded.payload," +
        "  parsed_json=excluded.parsed_json, content_hash=excluded.content_hash," +
        "  updated_at=excluded.updated_at" +
        " WHERE excluded.content_hash != skill_file.content_hash"
      ).bind(name, description, file.content, parsedJson, hash, file.mtime ?? now)
    );

    // FTS5 search_index row
    const title = description ? `${name}: ${description}` : name;
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
      ).bind("skill", name, `/memory/skills/${name}`, title, file.content.slice(0, 4000))
    );
  }

  for (let i = 0; i < stmts.length; i += 50) {
    try {
      await env.DASHBOARD_DB.batch(stmts.slice(i, i + 50));
    } catch {
      return json({ error: "storage write failed" }, 500);
    }
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// INGEST — POST /ingest/playbooks
// ---------------------------------------------------------------------------

export async function handleIngestPlaybooks(request: Request, env: V5Env): Promise<Response> {
  const authErr = await requireBearer(request, env.INGEST_TOKEN);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_PLAYBOOKS, "256 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schema = IngestPlaybooksSchema.safeParse(parsed);
  if (!schema.success) return json({ error: "invalid playbooks schema" }, 400);

  const { playbooks } = schema.data;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  for (const pb of playbooks) {
    const pk = `${pb.scope}:${pb.owner}:${pb.slug}`;
    const hash = await sha256Hex(pb.content);
    const description = extractDescription(pb.frontmatter ?? null);
    const parsedJson = pb.frontmatter ? JSON.stringify(pb.frontmatter) : null;

    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT INTO playbook_file (pk, scope, owner, slug, description, payload, parsed_json, content_hash, updated_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?)" +
        " ON CONFLICT(pk) DO UPDATE SET" +
        "  scope=excluded.scope, owner=excluded.owner, slug=excluded.slug," +
        "  description=excluded.description, payload=excluded.payload," +
        "  parsed_json=excluded.parsed_json, content_hash=excluded.content_hash," +
        "  updated_at=excluded.updated_at" +
        " WHERE excluded.content_hash != playbook_file.content_hash"
      ).bind(pk, pb.scope, pb.owner, pb.slug, description, pb.content, parsedJson, hash, pb.mtime ?? now)
    );

    // FTS5 search_index row
    const permalink = pb.scope === "agent"
      ? `/memory/playbooks/agent/${pb.owner}/${pb.slug}`
      : `/memory/playbooks/project/${pb.owner}/${pb.slug}`;
    const title = description ? `${pb.slug}: ${description}` : `${pb.owner}/${pb.slug}`;
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
      ).bind("playbook", pk, permalink, title, pb.content.slice(0, 4000))
    );
  }

  for (let i = 0; i < stmts.length; i += 50) {
    try {
      await env.DASHBOARD_DB.batch(stmts.slice(i, i + 50));
    } catch {
      return json({ error: "storage write failed" }, 500);
    }
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// INGEST — POST /ingest/project-memories
// ---------------------------------------------------------------------------

export async function handleIngestProjectMemories(request: Request, env: V5Env): Promise<Response> {
  const authErr = await requireBearer(request, env.INGEST_TOKEN);
  if (authErr) return authErr;

  const ct = request.headers.get("Content-Type") ?? "";
  if (!ct.includes("application/json")) return json({ error: "Content-Type must be application/json" }, 415);

  const bodyResult = await readBodyCapped(request, LIMIT_PROJECT_MEMORIES, "512 KB");
  if (!bodyResult.ok) return bodyResult.response;

  let parsed: unknown;
  try { parsed = JSON.parse(bodyResult.rawBody); } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const schema = IngestProjectMemoriesSchema.safeParse(parsed);
  if (!schema.success) return json({ error: "invalid project-memories schema" }, 400);

  const { projects } = schema.data;
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];

  for (const proj of projects) {
    const hash = await sha256Hex(proj.content);
    const reg = proj.registry ?? {};
    const staleness = proj.staleness ?? null;
    const recentRunsJson  = proj.recent_runs  ? JSON.stringify(proj.recent_runs)  : null;
    const recentCommsJson = proj.recent_comms ? JSON.stringify(proj.recent_comms) : null;
    const recentOutJson   = proj.recent_outputs ? JSON.stringify(proj.recent_outputs) : null;

    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT INTO project_memory_file" +
        "  (slug, status, repo, local_clone, deploy_url, payload, parsed_json," +
        "   staleness, staleness_days, recent_runs_json, recent_comms_json, recent_outputs_json," +
        "   content_hash, updated_at)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)" +
        " ON CONFLICT(slug) DO UPDATE SET" +
        "  status=excluded.status, repo=excluded.repo, local_clone=excluded.local_clone," +
        "  deploy_url=excluded.deploy_url, payload=excluded.payload, parsed_json=excluded.parsed_json," +
        "  staleness=excluded.staleness, staleness_days=excluded.staleness_days," +
        "  recent_runs_json=excluded.recent_runs_json, recent_comms_json=excluded.recent_comms_json," +
        "  recent_outputs_json=excluded.recent_outputs_json," +
        "  content_hash=excluded.content_hash, updated_at=excluded.updated_at" +
        " WHERE excluded.content_hash != project_memory_file.content_hash"
      ).bind(
        proj.slug,
        reg.status ?? null,
        reg.repo ?? null,
        reg.local_clone ?? null,
        reg.deploy_url ?? null,
        proj.content,
        null, // parsed_json — daemon may add structured parse later
        staleness?.verdict ?? null,
        staleness?.days ?? null,
        recentRunsJson,
        recentCommsJson,
        recentOutJson,
        hash,
        proj.mtime ?? now
      )
    );

    // FTS5 search_index row
    stmts.push(
      env.DASHBOARD_DB.prepare(
        "INSERT OR REPLACE INTO search_index (type, ref_id, permalink, title, body) VALUES (?,?,?,?,?)"
      ).bind(
        "project_memory",
        proj.slug,
        `/memory/projects/${proj.slug}`,
        `Project: ${proj.slug}`,
        proj.content.slice(0, 4000)
      )
    );
  }

  for (let i = 0; i < stmts.length; i += 50) {
    try {
      await env.DASHBOARD_DB.batch(stmts.slice(i, i + 50));
    } catch {
      return json({ error: "storage write failed" }, 500);
    }
  }

  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// READ — GET /skills
// ---------------------------------------------------------------------------

export async function handleGetSkills(request: Request, env: V5Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const result = await env.DASHBOARD_DB
    .prepare("SELECT name, description, content_hash, updated_at FROM skill_file ORDER BY updated_at DESC")
    .all<{ name: string; description: string | null; content_hash: string; updated_at: number }>();

  return json({ items: result.results });
}

// ---------------------------------------------------------------------------
// READ — GET /skills/:name
// ---------------------------------------------------------------------------

export async function handleGetSkill(request: Request, env: V5Env, name: string): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const row = await env.DASHBOARD_DB
    .prepare("SELECT name, description, payload, parsed_json, updated_at FROM skill_file WHERE name=?")
    .bind(name)
    .first<{ name: string; description: string | null; payload: string; parsed_json: string | null; updated_at: number }>();

  if (!row) return json({ error: "not found" }, 404);
  return json({ name: row.name, description: row.description, content: row.payload, parsed_json: row.parsed_json, updated_at: row.updated_at });
}

// ---------------------------------------------------------------------------
// READ — GET /playbooks
// ---------------------------------------------------------------------------

export async function handleGetPlaybooks(request: Request, env: V5Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const queryResult = PlaybooksQuerySchema.safeParse({
    scope: url.searchParams.get("scope") ?? undefined,
    owner: url.searchParams.get("owner") ?? undefined,
    q:     url.searchParams.get("q")     ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!queryResult.success) return json({ error: "invalid query parameters" }, 400);

  const { scope, owner, q, limit } = queryResult.data;

  // Build dynamic SQL
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (scope) { conditions.push("scope=?"); bindings.push(scope); }
  if (owner) { conditions.push("owner=?"); bindings.push(owner); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT pk, scope, owner, slug, description, content_hash, updated_at FROM playbook_file ${where} ORDER BY updated_at DESC LIMIT ?`;
  bindings.push(limit);

  const result = await env.DASHBOARD_DB
    .prepare(sql)
    .bind(...bindings)
    .all<{ pk: string; scope: string; owner: string; slug: string; description: string | null; content_hash: string; updated_at: number }>();

  let items = result.results;

  // Client-side text filter on name/description/owner (list small enough)
  if (q) {
    const lower = q.toLowerCase();
    items = items.filter((r) =>
      r.slug.toLowerCase().includes(lower) ||
      r.owner.toLowerCase().includes(lower) ||
      (r.description ?? "").toLowerCase().includes(lower)
    );
  }

  return json({ items });
}

// ---------------------------------------------------------------------------
// READ — GET /playbooks/:scope/:owner/:slug
// ---------------------------------------------------------------------------

export async function handleGetPlaybook(
  request: Request,
  env: V5Env,
  scope: string,
  owner: string,
  slug: string
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const pk = `${scope}:${owner}:${slug}`;
  const row = await env.DASHBOARD_DB
    .prepare("SELECT pk, scope, owner, slug, description, payload, parsed_json, updated_at FROM playbook_file WHERE pk=?")
    .bind(pk)
    .first<{ pk: string; scope: string; owner: string; slug: string; description: string | null; payload: string; parsed_json: string | null; updated_at: number }>();

  if (!row) return json({ error: "not found" }, 404);
  return json({ ...row, content: row.payload });
}

// ---------------------------------------------------------------------------
// READ — GET /project-memories
// ---------------------------------------------------------------------------

export async function handleGetProjectMemories(request: Request, env: V5Env): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const queryResult = ProjectMemoriesQuerySchema.safeParse({
    status:    url.searchParams.get("status")    ?? undefined,
    staleness: url.searchParams.get("staleness") ?? undefined,
  });
  if (!queryResult.success) return json({ error: "invalid query parameters" }, 400);

  const { status, staleness } = queryResult.data;

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (status)    { conditions.push("status=?");    bindings.push(status); }
  if (staleness) { conditions.push("staleness=?"); bindings.push(staleness); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql =
    `SELECT slug, status, deploy_url, staleness, staleness_days, updated_at,` +
    `  recent_runs_json, recent_comms_json` +
    ` FROM project_memory_file ${where} ORDER BY updated_at DESC LIMIT 200`;

  const result = await env.DASHBOARD_DB
    .prepare(sql)
    .bind(...bindings)
    .all<{
      slug: string;
      status: string | null;
      deploy_url: string | null;
      staleness: string | null;
      staleness_days: number | null;
      updated_at: number;
      recent_runs_json: string | null;
      recent_comms_json: string | null;
    }>();

  const items = result.results.map((row) => {
    let recentRunsCount = 0;
    let recentCommsCount = 0;
    try { recentRunsCount = row.recent_runs_json ? JSON.parse(row.recent_runs_json).length : 0; } catch { /* ignore */ }
    try { recentCommsCount = row.recent_comms_json ? JSON.parse(row.recent_comms_json).length : 0; } catch { /* ignore */ }
    return {
      slug:               row.slug,
      status:             row.status,
      deploy_url:         row.deploy_url,
      staleness:          row.staleness,
      staleness_days:     row.staleness_days,
      updated_at:         row.updated_at,
      recent_runs_count:  recentRunsCount,
      recent_comms_count: recentCommsCount,
    };
  });

  return json({ items });
}

// ---------------------------------------------------------------------------
// READ — GET /project-memories/:slug
// ---------------------------------------------------------------------------

export async function handleGetProjectMemory(
  request: Request,
  env: V5Env,
  slug: string
): Promise<Response> {
  const authErr = await requireCfAccess(request, env);
  if (authErr) return authErr;

  const row = await env.DASHBOARD_DB
    .prepare(
      "SELECT slug, status, repo, local_clone, deploy_url, payload, parsed_json," +
      "  staleness, staleness_days, recent_runs_json, recent_comms_json, recent_outputs_json, updated_at" +
      " FROM project_memory_file WHERE slug=?"
    )
    .bind(slug)
    .first<{
      slug: string;
      status: string | null;
      repo: string | null;
      local_clone: string | null;
      deploy_url: string | null;
      payload: string;
      parsed_json: string | null;
      staleness: string | null;
      staleness_days: number | null;
      recent_runs_json: string | null;
      recent_comms_json: string | null;
      recent_outputs_json: string | null;
      updated_at: number;
    }>();

  if (!row) return json({ error: "not found" }, 404);

  let recentRuns: unknown[] = [];
  let recentComms: unknown[] = [];
  let recentOutputs: unknown[] = [];
  try { recentRuns = row.recent_runs_json ? JSON.parse(row.recent_runs_json) : []; } catch { /* ignore */ }
  try { recentComms = row.recent_comms_json ? JSON.parse(row.recent_comms_json) : []; } catch { /* ignore */ }
  try { recentOutputs = row.recent_outputs_json ? JSON.parse(row.recent_outputs_json) : []; } catch { /* ignore */ }

  return json({
    slug:           row.slug,
    status:         row.status,
    repo:           row.repo,
    local_clone:    row.local_clone,
    deploy_url:     row.deploy_url,
    content:        row.payload,
    parsed_json:    row.parsed_json,
    staleness:      row.staleness,
    staleness_days: row.staleness_days,
    recent_runs:    recentRuns,
    recent_comms:   recentComms,
    recent_outputs: recentOutputs,
    updated_at:     row.updated_at,
  });
}
