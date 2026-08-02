import { z } from "zod";

export const TaskCreatedSchema = z.object({
  name: z.string(),
  dir: z.string(),
  branch: z.string(),
  base: z.string(),
  warnings: z.array(z.string()),
});

/** `name` is submitted, `label` is the ref creation really branches from
 * (`origin/main`). The inverse of `comparedBaseLabel` (lib/agentboard.ts),
 * which strips `origin/` on purpose — don't unify them. */
export const BaseBranchesSchema = z.array(
  z.object({
    name: z.string(),
    label: z.string(),
  }),
);

export type BaseBranch = z.infer<typeof BaseBranchesSchema>[number];

export const PastedImagePathsSchema = z.array(z.string());

/** `kind` stays an open `string`, not an enum: an older frontend can meet a
 * backend that grew a new guard, and `BlockerIcon` renders unknown kinds. */
export const TaskBlockerSchema = z.object({
  kind: z.string(),
  message: z.string(),
  remedy: z.string(),
  losesWork: z.boolean(),
  port: z.number().int().positive().max(65535).nullish(),
});

/** "Blocked" means **nothing** went: the guards refuse before the first
 * destructive step, so a refusal always leaves the task exactly as it was. */
export const TaskDeleteOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("deleted"),
    name: z.string(),
    messages: z.array(z.string()),
  }),
  z.object({
    status: z.literal("blocked"),
    name: z.string(),
    blockers: z.array(TaskBlockerSchema),
    /** Caveats gathered before the verdict — usually a failed `fetch --prune`,
     * meaning the guards judged against stale `origin/*`. */
    messages: z.array(z.string()),
  }),
]);

export type TaskDeleteOutcome = z.infer<typeof TaskDeleteOutcomeSchema>;
