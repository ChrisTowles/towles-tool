export const TEMPLATES = {
  plan: "01_plan.prompt.md",
  implement: "02_implement.prompt.md",
  simplify: "03_simplify.prompt.md",
  review: "04_review.prompt.md",
} as const;

export const PIPELINE_STEPS = [
  { order: 1, name: "plan", label: "01-Plan" },
  { order: 2, name: "implement", label: "02-Implement" },
  { order: 3, name: "simplify", label: "03-Simplify" },
  { order: 4, name: "review", label: "04-Review" },
] as const;

export type StepName = (typeof PIPELINE_STEPS)[number]["name"];
export const STEP_NAMES = PIPELINE_STEPS.map((s) => s.name);

/** Keyed lookup for step labels */
export const STEP_LABELS = Object.fromEntries(
  PIPELINE_STEPS.map((s) => [s.name, s.label]),
) as Record<string, string>;

export const ARTIFACTS = {
  initialRamblings: "initial-ramblings.md",
  plan: "plan.md",
  completedSummary: "completed-summary.md",
  simplifySummary: "simplify-summary.md",
  review: "review.md",
  prUrl: "pr-url.txt",
} as const;
