export const TEMPLATES = {
  research: "01_research.prompt.md",
  plan: "02_plan.prompt.md",
  planAnnotations: "03_plan-annotations.prompt.md",
  planImplementation: "04_plan-implementation.prompt.md",
  implement: "05_implement.prompt.md",
  review: "06_review.prompt.md",
  refresh: "07_refresh.prompt.md",
} as const;

export const PIPELINE_STEPS = [
  { order: 1, name: "research", label: "01-Research" },
  { order: 2, name: "plan", label: "02-Plan" },
  { order: 3, name: "plan-annotations", label: "03-Plan-Annotations" },
  { order: 4, name: "plan-implementation", label: "04-Plan-Implementation" },
  { order: 5, name: "implement", label: "05-Implement" },
  { order: 6, name: "review", label: "06-Review" },
  { order: 7, name: "create-pr", label: "07-Create PR" },
  { order: 8, name: "remove-label", label: "08-Remove Label" },
] as const;

export type StepName = (typeof PIPELINE_STEPS)[number]["name"];
export const STEP_NAMES = PIPELINE_STEPS.map((s) => s.name);

function toCamelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Keyed lookup for step labels (includes standalone "refresh" step) */
export const STEP_LABELS = {
  ...Object.fromEntries(PIPELINE_STEPS.map((s) => [toCamelCase(s.name), s.label])),
  refresh: "Refresh",
} as Record<string, string>;

export const ARTIFACTS = {
  initialRamblings: "initial-ramblings.md",
  research: "research.md",
  plan: "plan.md",
  planAnnotations: "plan-annotations.md",
  planAnnotationsAddressed: "plan-annotations-addressed.md",
  planImplementation: "plan-implementation.md",
  completedSummary: "completed-summary.md",
  review: "review.md",
  prUrl: "pr-url.txt",
} as const;
