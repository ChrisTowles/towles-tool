import type { PromptImprover, TaskTemplate } from "./settings";
import { slugify } from "./slug";

/** Permanent key, as `nextPromptImproverId` — `tt task new --template` names it. */
export function nextTaskTemplateId(templates: TaskTemplate[], label: string): string {
  const taken = new Set(templates.map((t) => t.id));
  const base = slugify(label) || "template";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `tt_tasks::presets::compose_goal`: the template's goal, then what was typed. */
export function composeGoal(template: TaskTemplate, typed: string): string {
  return [template.goal.trim(), typed.trim()].filter(Boolean).join("\n\n");
}

/** The template's improver leads, with its own button, ahead of the usual split.
 * An id that names no enabled improver changes nothing. */
export function withTemplateImprover(
  improvers: PromptImprover[],
  improverId: string | undefined,
): PromptImprover[] {
  const lead = improverId ? improvers.find((i) => i.id === improverId) : undefined;
  if (!lead) return improvers;
  return [{ ...lead, preferred: true }, ...improvers.filter((i) => i.id !== lead.id)];
}
