import { Schema } from "effect";
import { list } from "@/lib/schemas/shape";

export const TaskCreatedSchema = Schema.Struct({
  name: Schema.String,
  dir: Schema.String,
  branch: Schema.String,
  base: Schema.String,
  warnings: list(Schema.String),
});

/** `name` is submitted, `label` is the ref creation really branches from
 * (`origin/main`). The inverse of `comparedBaseLabel` (lib/agentboard.ts),
 * which strips `origin/` on purpose — don't unify them. */
export const BaseBranchesSchema = list(
  Schema.Struct({
    name: Schema.String,
    label: Schema.String,
  }),
);

export type BaseBranch = (typeof BaseBranchesSchema.Type)[number];

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Mirrors `tt_tasks::pr::PullRequest`. */
const PullRequestSchema = Schema.Struct({
  number: positiveInt,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  headBranch: Schema.String,
  baseBranch: Schema.String,
  crossRepository: Schema.Boolean,
  headOwner: Schema.String,
  author: Schema.String,
});

export type PullRequest = typeof PullRequestSchema.Type;

export const PullRequestsSchema = list(PullRequestSchema);

/** Mirrors `tt_tasks::ops::PrCheck`: where a review task for the PR would land. */
export const PrCheckSchema = Schema.Struct({
  pr: PullRequestSchema,
  branch: Schema.String,
  dir: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

export type PrCheck = typeof PrCheckSchema.Type;

export const PastedImagePathsSchema = list(Schema.String);

/** `kind` stays an open `string`, not an enum: an older frontend can meet a
 * backend that grew a new guard, and `BlockerIcon` renders unknown kinds. */
export const TaskBlockerSchema = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
  remedy: Schema.String,
  losesWork: Schema.Boolean,
  port: Schema.optional(Schema.NullOr(positiveInt.check(Schema.isLessThanOrEqualTo(65535)))),
});

/** "Blocked" means **nothing** went: the guards refuse before the first
 * destructive step, so a refusal always leaves the task exactly as it was. */
export const TaskDeleteOutcomeSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("deleted"),
    name: Schema.String,
    messages: list(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    name: Schema.String,
    blockers: list(TaskBlockerSchema),
    /** Caveats gathered before the verdict — usually a failed `fetch --prune`,
     * meaning the guards judged against stale `origin/*`. */
    messages: list(Schema.String),
  }),
]);

export type TaskDeleteOutcome = typeof TaskDeleteOutcomeSchema.Type;
