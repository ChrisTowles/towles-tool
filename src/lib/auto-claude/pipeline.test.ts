import { describe, expect, it } from "vitest";

import { STEP_NAMES } from "./pipeline";
import { PIPELINE_STEPS } from "./prompt-templates/index";

describe("STEP_NAMES", () => {
  it("should be derived from PIPELINE_STEPS", () => {
    expect(STEP_NAMES).toEqual(PIPELINE_STEPS.map((s) => s.name));
  });

  it("should have 8 steps", () => {
    expect(STEP_NAMES).toHaveLength(8);
  });
});
