import { describe, it, expect } from "vitest";
import { SnapshotV1Schema } from "../src/snapshot-schema";

// Minimal valid snapshot fixture
function makeValidSnapshot(): unknown {
  const agentIds = [
    "orchestrator", "intake",
    "dev_lead", "qa_lead", "biz_lead", "research_lead",
    "dev_backend", "dev_frontend", "data", "ux",
    "qa", "security",
    "prospect_researcher", "sales", "marketing", "risk", "client",
    "market_researcher", "market_watch",
    "architect", "devops", "finance", "critic",
  ];

  return {
    version: 1,
    generated_at: "2026-04-25T18:00:00.000Z",
    daemon_id: "sai-laptop",
    factory_root: "/home/sai/factory",
    agents: agentIds.map((id, idx) => ({
      id,
      tier: idx < 2 ? 0 : idx < 6 ? 1 : idx < 10 ? 2 : 3, // rough mapping
      parent: null,
      state: "idle",
      current_runs: [],
      blocker_text: null,
    })),
    pipelines: {
      active: [],
      recent: [],
    },
    recent_comms: [],
    meta: {
      daemon_version: "abc1234",
      parse_warnings_count: 0,
    },
  };
}

describe("SnapshotV1Schema", () => {
  it("accepts a valid snapshot", () => {
    const result = SnapshotV1Schema.safeParse(makeValidSnapshot());
    expect(result.success).toBe(true);
  });

  // version 2 is now accepted (v2 daemon rollover window — §10).
  // Test with a truly unknown version (99) which remains invalid.
  it("rejects unknown version (99) — version 1 and 2 are both valid", () => {
    const snap = { ...makeValidSnapshot() as Record<string, unknown>, version: 99 };
    const result = SnapshotV1Schema.safeParse(snap);
    expect(result.success).toBe(false);
    if (!result.success) {
      const versionIssue = result.error.issues.find((i) => i.path[0] === "version");
      expect(versionIssue).toBeDefined();
    }
  });

  it("rejects snapshot with wrong agent count (not 23)", () => {
    const snap = makeValidSnapshot() as Record<string, unknown>;
    const agents = (snap.agents as unknown[]).slice(0, 22);
    const result = SnapshotV1Schema.safeParse({ ...snap, agents });
    expect(result.success).toBe(false);
  });

  it("rejects missing required field (generated_at)", () => {
    const snap = { ...makeValidSnapshot() as Record<string, unknown> };
    delete snap.generated_at;
    const result = SnapshotV1Schema.safeParse(snap);
    expect(result.success).toBe(false);
  });

  it("rejects missing meta", () => {
    const snap = { ...makeValidSnapshot() as Record<string, unknown> };
    delete snap.meta;
    const result = SnapshotV1Schema.safeParse(snap);
    expect(result.success).toBe(false);
  });

  it("rejects recent_comms exceeding 10 entries", () => {
    const snap = makeValidSnapshot() as Record<string, unknown>;
    const comm = {
      filename: "dev_lead_to_qa_lead_20260425.md",
      from: "dev_lead",
      to: "qa_lead",
      subject: "Test",
      priority: "p1",
      timestamp: "2026-04-25T18:00:00.000Z",
      preview: "Test preview",
    };
    const result = SnapshotV1Schema.safeParse({
      ...snap,
      recent_comms: Array(11).fill(comm),
    });
    expect(result.success).toBe(false);
  });

  // Recent cap raised from 10 → 50 in v2 (Conveyor "show older" reveal).
  // 11 entries now accepted. Test with 51 to verify the new cap is enforced.
  it("rejects recent pipelines exceeding 50 entries (v2 cap)", () => {
    const snap = makeValidSnapshot() as Record<string, unknown>;
    const pipeline = {
      pipeline_name: "build_pipeline",
      run_id: "20260425_001",
      started_at: "2026-04-25T17:00:00.000Z",
      ended_at: "2026-04-25T17:30:00.000Z",
      result: "done",
      agent_lanes: [],
    };
    const result = SnapshotV1Schema.safeParse({
      ...snap,
      pipelines: {
        active: [],
        recent: Array(51).fill(pipeline),
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects agent with unknown id", () => {
    const snap = makeValidSnapshot() as Record<string, unknown>;
    const agents = [...(snap.agents as unknown[])];
    (agents[0] as Record<string, unknown>).id = "unknown_agent";
    const result = SnapshotV1Schema.safeParse({ ...snap, agents });
    expect(result.success).toBe(false);
  });

  describe("AgentLaneSchema.agent_id — relaxed to z.string().min(1).max(40)", () => {
    function makeRecentPipeline(agentId: string) {
      return {
        pipeline_name: "build_pipeline",
        run_id: "20260426_001",
        started_at: "2026-04-26T07:00:00.000Z",
        ended_at: "2026-04-26T07:30:00.000Z",
        result: "done",
        agent_lanes: [{
          agent_id: agentId,
          started_at: "2026-04-26T07:00:00.000Z",
          ended_at: "2026-04-26T07:30:00.000Z",
          state: "done",
        }],
      };
    }

    it("accepts pipeline-stage agent_id 'staging_audit'", () => {
      const snap = makeValidSnapshot() as Record<string, unknown>;
      const result = SnapshotV1Schema.safeParse({
        ...snap,
        pipelines: { active: [], recent: [makeRecentPipeline("staging_audit")] },
      });
      expect(result.success).toBe(true);
    });

    it("accepts pipeline-stage agent_id 'promote'", () => {
      const snap = makeValidSnapshot() as Record<string, unknown>;
      const result = SnapshotV1Schema.safeParse({
        ...snap,
        pipelines: { active: [], recent: [makeRecentPipeline("promote")] },
      });
      expect(result.success).toBe(true);
    });

    it("rejects empty agent_id '' (min 1)", () => {
      const snap = makeValidSnapshot() as Record<string, unknown>;
      const result = SnapshotV1Schema.safeParse({
        ...snap,
        pipelines: { active: [], recent: [makeRecentPipeline("")] },
      });
      expect(result.success).toBe(false);
    });

    it("rejects agent_id of 41 chars (max 40)", () => {
      const snap = makeValidSnapshot() as Record<string, unknown>;
      const result = SnapshotV1Schema.safeParse({
        ...snap,
        pipelines: { active: [], recent: [makeRecentPipeline("a".repeat(41))] },
      });
      expect(result.success).toBe(false);
    });

    it("AgentStateSchema.id still rejects 'staging_audit' (enum stays strict)", () => {
      const snap = makeValidSnapshot() as Record<string, unknown>;
      const agents = [...(snap.agents as Record<string, unknown>[])];
      agents[0] = { ...agents[0], id: "staging_audit" };
      const result = SnapshotV1Schema.safeParse({ ...snap, agents });
      expect(result.success).toBe(false);
    });
  });

  it("accepts snapshot with running agent and RunRef", () => {
    const snap = makeValidSnapshot() as Record<string, unknown>;
    const agents = [...(snap.agents as Record<string, unknown>[])];
    agents[2] = {
      ...agents[2],
      state: "running",
      current_runs: [{
        run_id: "20260425_180407",
        pipeline: "build_pipeline",
        current_task: "Writing backend worker",
        started_at: "2026-04-25T18:00:00.000Z",
        duration_s: 120,
        state: "running",
        blocker_text: null,
      }],
    };
    const result = SnapshotV1Schema.safeParse({ ...snap, agents });
    expect(result.success).toBe(true);
  });
});
