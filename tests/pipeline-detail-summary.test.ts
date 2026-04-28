import { describe, it, expect } from "vitest";
import { PipelineDetailIngestSchema } from "../src/snapshot-schema";

function makeBasePayload(): Record<string, unknown> {
  return {
    run_id: "20260427_210841",
    pipeline_type: "build",
    status: "done",
    started_at: "2026-04-27T21:08:41Z",
    ended_at: "2026-04-27T21:45:00Z",
    beats: [
      {
        agent_id: "dev_lead",
        started_at: "2026-04-27T21:08:41Z",
        ended_at: "2026-04-27T21:45:00Z",
        state: "done",
        output_file: "outputs/20260427_210841/dev_lead_report.md",
      },
    ],
    comms: [
      {
        filename: "dev_lead_to_qa_lead_20260427.md",
        from: "dev_lead",
        to: "qa_lead",
        subject: "Handoff — backend done",
        preview: "Backend complete. Handing to QA.",
        timestamp: "2026-04-27T21:40:00Z",
      },
    ],
  };
}

describe("PipelineDetailIngestSchema — summary field (iter 7)", () => {
  it("accepts payload WITHOUT summary (backward compat)", () => {
    const result = PipelineDetailIngestSchema.safeParse(makeBasePayload());
    expect(result.success).toBe(true);
  });

  it("accepts payload WITH full summary", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "Build dashboard v2 iter 7",
        commits: [
          {
            sha: "c25ddde",
            subject: "feat(dashboard): add summary field",
            author: "dev",
            ts: "2026-04-27T21:30:00Z",
          },
        ],
        referenced_issues: ["#22", "#5"],
        qa_verdict: "PASS",
        top_findings: [
          { severity: "P0", title: "Missing auth on /admin", source: "qa" },
          { severity: "P1", title: "Slow query on load", source: "security" },
        ],
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("accepts payload with summary where qa_verdict is null", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "some task",
        commits: [],
        referenced_issues: [],
        qa_verdict: null,
        top_findings: [],
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("accepts payload with summary where all fields are empty", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "",
        commits: [],
        referenced_issues: [],
        qa_verdict: null,
        top_findings: [],
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects summary with unknown qa_verdict value", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "t",
        commits: [],
        referenced_issues: [],
        qa_verdict: "UNKNOWN",
        top_findings: [],
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects summary with commit subject exceeding 140 chars", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "t",
        commits: [
          {
            sha: "abc1234",
            subject: "x".repeat(141),
            author: "dev",
            ts: "2026-04-27T21:30:00Z",
          },
        ],
        referenced_issues: [],
        qa_verdict: null,
        top_findings: [],
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects summary with more than 10 commits", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "t",
        commits: Array(11).fill({
          sha: "abc1234",
          subject: "a commit",
          author: "dev",
          ts: "2026-04-27T21:30:00Z",
        }),
        referenced_issues: [],
        qa_verdict: null,
        top_findings: [],
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects summary with more than 3 top_findings", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "t",
        commits: [],
        referenced_issues: [],
        qa_verdict: null,
        top_findings: Array(4).fill({
          severity: "P0",
          title: "Some finding",
          source: "qa",
        }),
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects summary with more than 20 referenced_issues", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "t",
        commits: [],
        referenced_issues: Array(21).fill("#1"),
        qa_verdict: null,
        top_findings: [],
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects summary with unknown finding source", () => {
    const payload = {
      ...makeBasePayload(),
      summary: {
        task: "t",
        commits: [],
        referenced_issues: [],
        qa_verdict: null,
        top_findings: [
          { severity: "P0", title: "Issue", source: "unknown_source" },
        ],
      },
    };
    const result = PipelineDetailIngestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
