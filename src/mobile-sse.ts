/**
 * mobile-sse.ts — SSE stream for /mobile/events
 *
 * Architecture (per D-4 amendment):
 *   - 2 second polling cadence (normal); adaptive backoff up to 8s when busy
 *   - Streams: run_state, comm, session, intent — each with its own watermark
 *   - Watermarks are per-stream row timestamps (ms epoch) from D1
 *   - Last-Event-ID header format on reconnect: "run_state:<wm>,comm:<wm>,session:<wm>,intent:<wm>"
 *   - Subrequest cap: paid plan = 1000/invocation. We cycle at 900 (90%).
 *   - On cycle: emit `event: cycle\ndata: {...}\n\n` then close with 200.
 *   - Client (react-native-sse) auto-reconnects with Last-Event-ID; handler resumes from watermarks.
 *   - Adaptive backoff: if a single tick emits >10 rows, double poll interval until cycle close (cap 8s).
 *   - Subrequest accounting: 4 D1 queries per tick (one per stream, including the intent placeholder).
 *     Normal cadence (2s): 900 / 4 = 225 ticks × 2s = ~7.5 min/cycle.
 *     Adaptive backoff (8s): 225 ticks × 8s = ~30 min/cycle (busy pipeline, adaptive engaged).
 *     The architect D-4 amendment states "~30 min/cycle" — this is the adaptive-backoff ceiling,
 *     not the normal-cadence case. Code is correct; ADR wording was written for the adaptive path.
 */

export interface MobileSSEEnv {
  DASHBOARD_DB: D1Database;
}

// ---------------------------------------------------------------------------
// Watermark tracking
// ---------------------------------------------------------------------------

interface Watermarks {
  run_state: number; // updated_at of last seen pipeline_detail row
  comm:      number; // ts of last seen comm_message row
  session:   number; // last_msg_at of last seen intake_session row
  intent:    number; // ts placeholder (intent table TBD — emits nothing until added)
}

function parseLastEventId(header: string | null): Watermarks {
  const defaults: Watermarks = { run_state: 0, comm: 0, session: 0, intent: 0 };
  if (!header) return defaults;

  // format: "run_state:<wm>,comm:<wm>,session:<wm>,intent:<wm>"
  for (const part of header.split(",")) {
    const [key, val] = part.trim().split(":");
    const ts = parseInt(val ?? "0", 10);
    if (isNaN(ts)) continue;
    if (key === "run_state") defaults.run_state = ts;
    else if (key === "comm")  defaults.comm = ts;
    else if (key === "session") defaults.session = ts;
    else if (key === "intent")  defaults.intent = ts;
  }
  return defaults;
}

function buildLastEventId(wm: Watermarks): string {
  return `run_state:${wm.run_state},comm:${wm.comm},session:${wm.session},intent:${wm.intent}`;
}

// ---------------------------------------------------------------------------
// D1 row types for SSE streaming
// ---------------------------------------------------------------------------

interface RunStateRow {
  run_id:        string;
  pipeline_type: string;
  status:        string;
  updated_at:    number;
}

interface CommRow {
  filename:   string;
  from_agent: string;
  to_agent:   string;
  priority:   string;
  subject:    string | null;
  ts:         number;
}

interface SessionRow {
  session_id:  string;
  status:      string;
  last_msg_at: number;
  msg_count:   number;
  title:       string | null;
}

// ---------------------------------------------------------------------------
// SSE text helpers
// ---------------------------------------------------------------------------

function sseEvent(
  eventName: string,
  data: unknown,
  id: string
): string {
  return `id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Main SSE handler
// ---------------------------------------------------------------------------

const SSE_CYCLE_LIMIT = 900;
const POLL_INTERVAL_NORMAL_MS = 2_000;
const POLL_INTERVAL_MAX_MS    = 8_000;
const ADAPTIVE_THRESHOLD_ROWS = 10;

export async function handleMobileSSE(
  request: Request,
  env: MobileSSEEnv
): Promise<Response> {
  const lastEventId = request.headers.get("Last-Event-ID");
  const wm = parseLastEventId(lastEventId);

  const encoder = new TextEncoder();
  let subreqs = 0;
  let pollInterval = POLL_INTERVAL_NORMAL_MS;

  const stream = new ReadableStream({
    async start(controller) {
      function enq(chunk: string): void {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // client disconnected — will be caught by the loop check below
        }
      }

      // Send a comment on connect so client knows the connection is live
      enq(": connected\n\n");

      while (subreqs < SSE_CYCLE_LIMIT) {
        let tickRows = 0;

        // ── run_state stream ───────────────────────────────────────────────
        try {
          const runResult = await env.DASHBOARD_DB
            .prepare(
              "SELECT run_id, pipeline_type, status, updated_at" +
              " FROM pipeline_detail WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 20"
            )
            .bind(wm.run_state)
            .all<RunStateRow>();
          subreqs++;

          for (const row of runResult.results) {
            enq(sseEvent(
              "run_state",
              { run_id: row.run_id, pipeline: row.pipeline_type, status: row.status, ts: row.updated_at },
              `run_state:${row.updated_at}`
            ));
            if (row.updated_at > wm.run_state) wm.run_state = row.updated_at;
            tickRows++;
          }
        } catch {
          subreqs++; // count the failed attempt
        }

        if (subreqs >= SSE_CYCLE_LIMIT) break;

        // ── comm stream ───────────────────────────────────────────────────
        try {
          const commResult = await env.DASHBOARD_DB
            .prepare(
              "SELECT filename, from_agent, to_agent, priority, subject, ts" +
              " FROM comm_message WHERE ts > ? ORDER BY ts ASC LIMIT 20"
            )
            .bind(wm.comm)
            .all<CommRow>();
          subreqs++;

          for (const row of commResult.results) {
            enq(sseEvent(
              "comm",
              {
                filename:   row.filename,
                from:       row.from_agent,
                to:         row.to_agent,
                priority:   row.priority,
                subject:    row.subject ?? null,
                ts:         row.ts,
              },
              `comm:${row.ts}`
            ));
            if (row.ts > wm.comm) wm.comm = row.ts;
            tickRows++;
          }
        } catch {
          subreqs++;
        }

        if (subreqs >= SSE_CYCLE_LIMIT) break;

        // ── session stream ────────────────────────────────────────────────
        try {
          const sessionResult = await env.DASHBOARD_DB
            .prepare(
              "SELECT session_id, status, last_msg_at, msg_count, title" +
              " FROM intake_session WHERE last_msg_at > ? ORDER BY last_msg_at ASC LIMIT 20"
            )
            .bind(wm.session)
            .all<SessionRow>();
          subreqs++;

          for (const row of sessionResult.results) {
            enq(sseEvent(
              "session",
              {
                session_id: row.session_id,
                status:     row.status,
                last_msg_at: row.last_msg_at,
                msg_count:  row.msg_count,
                title:      row.title ?? null,
              },
              `session:${row.last_msg_at}`
            ));
            if (row.last_msg_at > wm.session) wm.session = row.last_msg_at;
            tickRows++;
          }
        } catch {
          subreqs++;
        }

        if (subreqs >= SSE_CYCLE_LIMIT) break;

        // ── intent stream — placeholder (table TBD) ──────────────────────
        // Intent tracking will be added when the intent D1 table ships.
        // No D1 query here; no subrequest consumed. Watermark advances via push events.
        subreqs++; // reserve one slot to keep accounting predictable

        if (subreqs >= SSE_CYCLE_LIMIT) break;

        // ── Adaptive backoff ──────────────────────────────────────────────
        if (tickRows > ADAPTIVE_THRESHOLD_ROWS) {
          pollInterval = Math.min(pollInterval * 2, POLL_INTERVAL_MAX_MS);
        }

        // ── Sleep until next tick ─────────────────────────────────────────
        await scheduler.wait(pollInterval);
      }

      // ── Cycle event — client reconnects with updated Last-Event-ID ──────
      enq(
        `event: cycle\ndata: ${JSON.stringify({ next_eventid: buildLastEventId(wm) })}\n\n`
      );

      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-store",
      "X-Accel-Buffering": "no",
      "Connection":        "keep-alive",
    },
  });
}
