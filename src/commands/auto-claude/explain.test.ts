import { describe, expect, it } from "vitest";

import { ARTIFACTS, PIPELINE_STEPS, STEP_NAMES } from "./prompt-templates/index";
import { buildStepInfos, printStepTemplate } from "./explain";

describe("buildStepInfos", () => {
  it("returns one entry per pipeline step", () => {
    const infos = buildStepInfos();
    expect(infos).toHaveLength(PIPELINE_STEPS.length);
  });

  it("preserves pipeline step order", () => {
    const infos = buildStepInfos();
    expect(infos.map((i) => i.name)).toEqual(STEP_NAMES);
  });

  it("every step has a template file, description, inputs, and outputs", () => {
    for (const info of buildStepInfos()) {
      expect(info.templateFile).toBeTruthy();
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.inputs.length).toBeGreaterThan(0);
      expect(info.outputs.length).toBeGreaterThan(0);
    }
  });

  it("plan step reads initial-ramblings and outputs plan", () => {
    const plan = buildStepInfos().find((i) => i.name === "plan")!;
    expect(plan.inputs).toContain(ARTIFACTS.initialRamblings);
    expect(plan.outputs).toContain(ARTIFACTS.plan);
  });

  it("implement step reads plan and outputs completed-summary", () => {
    const impl = buildStepInfos().find((i) => i.name === "implement")!;
    expect(impl.inputs).toContain(ARTIFACTS.plan);
    expect(impl.outputs).toContain(ARTIFACTS.completedSummary);
  });

  it("review step outputs review artifact", () => {
    const review = buildStepInfos().find((i) => i.name === "review")!;
    expect(review.outputs).toContain(ARTIFACTS.review);
  });
});

describe("printStepTemplate", () => {
  it("throws for an unknown step name", () => {
    expect(() => printStepTemplate("nonexistent")).toThrow(/Unknown step "nonexistent"/);
  });

  it("throws with valid step names in the error message", () => {
    expect(() => printStepTemplate("bad")).toThrow(/plan, implement, simplify, review/);
  });

  it("does not throw for valid step names", () => {
    for (const name of STEP_NAMES) {
      expect(() => printStepTemplate(name)).not.toThrow();
    }
  });
});
