import { readFileSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";
import { colorize } from "consola/utils";

import { ARTIFACTS, PIPELINE_STEPS, TEMPLATES } from "./prompt-templates/index.js";
import type { StepName } from "./prompt-templates/index.js";
import { TEMPLATES_DIR } from "./templates.js";

interface StepInfo {
  order: number;
  name: string;
  label: string;
  templateFile: string;
  description: string;
  inputs: string[];
  outputs: string[];
}

const STEP_DETAILS: Record<StepName, { description: string; inputs: string[]; outputs: string[] }> =
  {
    plan: {
      description: "Research the issue and codebase, then produce a detailed implementation plan",
      inputs: [ARTIFACTS.initialRamblings],
      outputs: [ARTIFACTS.plan],
    },
    implement: {
      description:
        "Follow the plan checklist task-by-task using red/green TDD, then verify all checks pass",
      inputs: [ARTIFACTS.plan, `${ARTIFACTS.review} (on retry)`],
      outputs: [ARTIFACTS.completedSummary],
    },
    simplify: {
      description:
        "Review branch changes and simplify: remove dead code, inline over-abstractions, tighten types",
      inputs: [ARTIFACTS.completedSummary],
      outputs: [ARTIFACTS.simplifySummary],
    },
    review: {
      description:
        "Run automated checks then manually review the diff for correctness, security, and coverage",
      inputs: [ARTIFACTS.plan, "git diff"],
      outputs: [ARTIFACTS.review],
    },
  };

export function buildStepInfos(): StepInfo[] {
  const templateMap: Record<string, string> = TEMPLATES;
  return PIPELINE_STEPS.map((s) => ({
    order: s.order,
    name: s.name,
    label: s.label,
    templateFile: templateMap[s.name] ?? "(none)",
    ...STEP_DETAILS[s.name],
  }));
}

export function printExplain(): void {
  consola.log("");
  consola.log(colorize("bold", "auto-claude pipeline"));
  consola.log(
    colorize("dim", "Steps 2-4 loop up to maxReviewRetries times if review returns FAIL\n"),
  );

  for (const step of buildStepInfos()) {
    consola.log(colorize("cyan", `  ${step.label}`));
    consola.log(`    ${step.description}`);
    consola.log(`    ${colorize("dim", "template:")} ${step.templateFile}`);
    consola.log(`    ${colorize("green", "inputs:")}  ${step.inputs.join(", ")}`);
    consola.log(`    ${colorize("yellow", "outputs:")} ${step.outputs.join(", ")}`);
    consola.log("");
  }
}

export function printStepTemplate(stepName: string): void {
  const step = PIPELINE_STEPS.find((s) => s.name === stepName);
  if (!step) {
    throw new Error(
      `Unknown step "${stepName}". Valid steps: ${PIPELINE_STEPS.map((s) => s.name).join(", ")}`,
    );
  }

  const templateMap: Record<string, string> = TEMPLATES;
  const templateFile = templateMap[step.name];
  if (!templateFile) {
    throw new Error(`No template found for step "${stepName}"`);
  }

  const templatePath = join(TEMPLATES_DIR, templateFile);
  const content = readFileSync(templatePath, "utf-8");

  consola.log("");
  consola.log(colorize("bold", `Template: ${templateFile}`));
  consola.log(colorize("dim", `Step: ${step.label} (${step.name})\n`));
  consola.log(content);
}
