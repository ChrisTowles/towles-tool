import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ARTIFACTS, PIPELINE_STEPS, STEP_LABELS, STEP_NAMES, TEMPLATES } from "./index";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("TEMPLATES", () => {
  it("should have all expected keys", () => {
    expect(Object.keys(TEMPLATES)).toEqual([
      "research",
      "plan",
      "planAnnotations",
      "planImplementation",
      "implement",
      "review",
      "refresh",
    ]);
  });

  it("every template file should exist on disk", () => {
    for (const [key, filename] of Object.entries(TEMPLATES)) {
      const fullPath = join(__dirname, filename);
      expect(existsSync(fullPath), `TEMPLATES.${key} → ${filename} missing`).toBe(true);
    }
  });

  it("filenames should follow XX-prompt-*.md pattern", () => {
    for (const filename of Object.values(TEMPLATES)) {
      expect(filename).toMatch(/^\d{2}-prompt-.+\.md$/);
    }
  });

  it("filenames should be in ascending numeric order", () => {
    const numbers = Object.values(TEMPLATES).map((f) => Number.parseInt(f.slice(0, 2), 10));
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
    }
  });
});

describe("PIPELINE_STEPS", () => {
  it("should have 8 steps", () => {
    expect(PIPELINE_STEPS).toHaveLength(8);
  });

  it("each step should have order, name, and label", () => {
    for (const step of PIPELINE_STEPS) {
      expect(step).toHaveProperty("order");
      expect(step).toHaveProperty("name");
      expect(step).toHaveProperty("label");
      expect(typeof step.order).toBe("number");
      expect(typeof step.name).toBe("string");
      expect(typeof step.label).toBe("string");
    }
  });

  it("order should be sequential starting from 1", () => {
    for (let i = 0; i < PIPELINE_STEPS.length; i++) {
      expect(PIPELINE_STEPS[i].order).toBe(i + 1);
    }
  });

  it("names should match expected pipeline order", () => {
    expect(PIPELINE_STEPS.map((s) => s.name)).toEqual([
      "research",
      "plan",
      "plan-annotations",
      "plan-implementation",
      "implement",
      "review",
      "create-pr",
      "remove-label",
    ]);
  });

  it("labels should include the order number", () => {
    for (const step of PIPELINE_STEPS) {
      const prefix = String(step.order).padStart(2, "0");
      expect(step.label.startsWith(prefix), `${step.label} should start with ${prefix}`).toBe(true);
    }
  });
});

describe("STEP_NAMES", () => {
  it("should be derived from PIPELINE_STEPS", () => {
    expect(STEP_NAMES).toEqual(PIPELINE_STEPS.map((s) => s.name));
  });
});

describe("STEP_LABELS", () => {
  it("should have camelCase keys for all pipeline steps plus refresh", () => {
    expect(Object.keys(STEP_LABELS)).toEqual([
      "research",
      "plan",
      "planAnnotations",
      "planImplementation",
      "implement",
      "review",
      "createPr",
      "removeLabel",
      "refresh",
    ]);
  });

  it("pipeline labels should have numeric prefixes", () => {
    const pipelineLabels = { ...STEP_LABELS };
    delete pipelineLabels.refresh;

    for (const label of Object.values(pipelineLabels)) {
      expect(label).toMatch(/^\d{2}-/);
    }
  });

  it("should match labels from PIPELINE_STEPS", () => {
    for (const step of PIPELINE_STEPS) {
      const values = Object.values(STEP_LABELS);
      expect(values).toContain(step.label);
    }
  });
});

describe("ARTIFACTS", () => {
  it("should have all expected keys", () => {
    expect(Object.keys(ARTIFACTS)).toEqual([
      "initialRamblings",
      "research",
      "plan",
      "planAnnotations",
      "planAnnotationsAddressed",
      "planImplementation",
      "completedSummary",
      "review",
      "prUrl",
    ]);
  });

  it("all values should be valid filenames", () => {
    for (const filename of Object.values(ARTIFACTS)) {
      expect(filename).toMatch(/^[\w-]+\.\w+$/);
    }
  });
});
