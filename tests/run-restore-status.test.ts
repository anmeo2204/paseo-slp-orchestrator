import { describe, expect, it } from "vitest";
import { inferRestoredRunStatus } from "../server/pipeline/run-restore";
import type { Run } from "../shared/state";

function restoredRun(pipelines: { id: string; status: string }[], supervisorReport: string | null): Run {
  return {
    criteria: "ship the feature",
    supervisorReport,
    finalReport: supervisorReport,
    archivedFromStatus: "running",
    qaLeadAgentId: "",
    masterLeadAgentId: "lead",
    agents: {},
    pipelines: Object.fromEntries(pipelines.map((pipeline) => [pipeline.id, { id: pipeline.id, kind: "feature", status: pipeline.status }])),
  } as unknown as Run;
}

describe("inferRestoredRunStatus", () => {
  it("continues a later pipeline that is still open even when an earlier wave left a supervisor report", () => {
    const run = restoredRun(
      [
        { id: "p09-3", status: "integrated" },
        { id: "p09-4", status: "starting" },
      ],
      "P09.3 accepted",
    );
    expect(inferRestoredRunStatus(run)).toBe("running");
  });

  it("returns to final approval only when every pipeline is already integrated", () => {
    const run = restoredRun([{ id: "p09-3", status: "integrated" }], "P09.3 accepted");
    expect(inferRestoredRunStatus(run)).toBe("awaiting_user");
  });
});
