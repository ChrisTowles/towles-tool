import { Schema } from "effect";
import { list } from "@/lib/schemas/shape";

/** Mirrors `tt_agentboard::queue` — validated because it crosses IPC. */
const WaitReasonSchema = Schema.Literals([
  "unblock",
  "answer",
  "review",
  "fix_ci",
  "address_review",
  "land",
  "cleanup",
]);
export type WaitReason = typeof WaitReasonSchema.Type;

const LaneSchema = Schema.Literals(["on_you", "idle", "running", "parked", "no_shell"]);
export type Lane = typeof LaneSchema.Type;

const QueuePrSchema = Schema.Struct({
  repo: Schema.String,
  number: Schema.Number,
  url: Schema.String,
  state: Schema.String,
  checks: Schema.String,
  reviewState: Schema.String,
});

const QueueCiSchema = Schema.Struct({
  workflow: Schema.String,
  url: Schema.String,
  conclusion: Schema.String,
  updatedMs: Schema.Number,
});

const ParkKindSchema = Schema.Literals(["blocked", "later", "parked"]);
export type ParkKind = typeof ParkKindSchema.Type;

/** Why a parked task is back in the list without an unpark. */
const ParkDueSchema = Schema.Literals(["date", "changed", "landed"]);

/** `tt_agentboard::queue::QueuePark` — a task's park as the queue sees it now. */
const QueueParkSchema = Schema.Struct({
  kind: ParkKindSchema,
  note: Schema.NullOr(Schema.String),
  untilMs: Schema.NullOr(Schema.Number),
  atMs: Schema.Number,
  due: Schema.NullOr(ParkDueSchema),
  /** Out of sight: not due, and no agent asks or errors in the checkout. */
  held: Schema.Boolean,
});
export type QueuePark = typeof QueueParkSchema.Type;

/** One checkout — a task's worktree or a repo root; `folderDir` is its identity. */
const QueueItemSchema = Schema.Struct({
  taskId: Schema.NullOr(Schema.Number),
  lane: LaneSchema,
  reason: Schema.NullOr(WaitReasonSchema),
  /** `reason` in words — `WaitReason::phrase` in Rust. */
  why: Schema.NullOr(Schema.String),
  also: list(WaitReasonSchema),
  title: Schema.String,
  repo: Schema.String,
  branch: Schema.String,
  folderDir: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  said: Schema.NullOr(Schema.String),
  runningAgents: Schema.Number,
  pr: Schema.NullOr(QueuePrSchema),
  ci: list(QueueCiSchema),
  rank: Schema.NullOr(Schema.Number),
  sinceMs: Schema.NullOr(Schema.Number),
  snoozedUntilMs: Schema.NullOr(Schema.Number),
  snoozedUntilCi: Schema.Boolean,
  snoozed: Schema.Boolean,
  park: Schema.NullOr(QueueParkSchema),
});
export type QueueItem = typeof QueueItemSchema.Type;

export const TaskQueueSchema = Schema.Struct({
  /** The `folderDir` of the first row on you. */
  next: Schema.NullOr(Schema.String),
  items: list(QueueItemSchema),
});
export type TaskQueue = typeof TaskQueueSchema.Type;
