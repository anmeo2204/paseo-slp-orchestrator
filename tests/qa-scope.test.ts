import { describe, expect, it } from "vitest";
import type { PipelineState } from "../shared/pipeline";
import type { Run } from "../shared/state";
import { featurePipelinesForQa } from "../server/pipeline/qa/qa-phase-state";

function pipeline(id: string, kind: "feature" | "qa", createdAt: string, integratedAt: string | null): PipelineState {
  return { id, name: id, kind, status: integratedAt ? "integrated" : "running", createdAt, integratedAt } as unknown as PipelineState;
}

function runWith(...pipelines: PipelineState[]): Run {
  return { pipelines: Object.fromEntries(pipelines.map((candidate) => [candidate.id, candidate])) } as unknown as Run;
}

const names = (pipelines: PipelineState[]) => pipelines.map((candidate) => candidate.id);

describe("features a QA pass verifies", () => {
  it("covers every merged feature in the first QA pass", () => {
    const run = runWith(pipeline("f1", "feature", "T01", "T02"), pipeline("f2", "feature", "T01", "T03"));
    expect(names(featurePipelinesForQa(run))).toEqual(["f1", "f2"]);
  });

  it("covers only features merged after the previous QA pass closed", () => {
    const qa1 = pipeline("qa1", "qa", "T04", "T05");
    const qa2 = pipeline("qa2", "qa", "T08", null);
    const run = runWith(pipeline("f1", "feature", "T01", "T03"), qa1, pipeline("f2", "feature", "T06", "T07"), qa2);
    expect(names(featurePipelinesForQa(run))).toEqual(["f2"]);
    expect(names(featurePipelinesForQa(run, qa2))).toEqual(["f2"]);
  });

  it("falls back to the previous pass when nothing merged since it closed (Supervisor rework)", () => {
    const run = runWith(pipeline("f1", "feature", "T01", "T02"), pipeline("qa1", "qa", "T03", "T04"), pipeline("qa2", "qa", "T05", null));
    expect(names(featurePipelinesForQa(run, run.pipelines.qa2))).toEqual(["f1"]);
  });

  it("keeps a later wave's rework on that wave, not on features an earlier pass already verified", () => {
    const qa1 = pipeline("qa1", "qa", "T04", "T05");
    const qa2 = pipeline("qa2", "qa", "T08", "T09");
    const qa3 = pipeline("qa3", "qa", "T10", null);
    const run = runWith(pipeline("f1", "feature", "T01", "T03"), qa1, pipeline("f2", "feature", "T06", "T07"), qa2, qa3);
    expect(names(featurePipelinesForQa(run, qa2))).toEqual(["f2"]);
    expect(names(featurePipelinesForQa(run, qa3))).toEqual(["f2"]);
    expect(names(featurePipelinesForQa(run))).toEqual(["f2"]);
  });
});
