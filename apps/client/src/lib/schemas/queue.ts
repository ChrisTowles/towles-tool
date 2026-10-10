import { z } from "zod";

/** Mirrors `tt_agentboard::queue` — validated because it crosses IPC. */
export const WaitReasonSchema = z.enum([
  "unblock",
  "answer",
  "review",
  "fix_ci",
  "address_review",
  "land",
  "cleanup",
  "start",
]);
export type WaitReason = z.infer<typeof WaitReasonSchema>;

export const LaneSchema = z.enum(["on_you", "running", "parked", "backlog"]);
export type Lane = z.infer<typeof LaneSchema>;

export const QueueKeySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), id: z.number() }),
  z.object({ kind: z.literal("unfiled"), folderDir: z.string() }),
]);
export type QueueKey = z.infer<typeof QueueKeySchema>;

export const QueuePrSchema = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  state: z.string(),
  checks: z.string(),
  reviewState: z.string(),
});

export const QueueItemSchema = z.object({
  key: QueueKeySchema,
  lane: LaneSchema,
  reason: WaitReasonSchema.nullable(),
  also: z.array(WaitReasonSchema),
  title: z.string(),
  goal: z.string().nullable(),
  repo: z.string(),
  branch: z.string().nullable(),
  folderDir: z.string().nullable(),
  sessionId: z.string().nullable(),
  said: z.string().nullable(),
  runningAgents: z.number(),
  pr: QueuePrSchema.nullable(),
  rank: z.number(),
  sinceMs: z.number().nullable(),
  snoozedUntilMs: z.number().nullable(),
  snoozed: z.boolean(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const TaskQueueSchema = z.object({
  next: QueueKeySchema.nullable(),
  items: z.array(QueueItemSchema),
});
export type TaskQueue = z.infer<typeof TaskQueueSchema>;
