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
]);
export type WaitReason = z.infer<typeof WaitReasonSchema>;

export const LaneSchema = z.enum(["on_you", "running", "parked", "idle"]);
export type Lane = z.infer<typeof LaneSchema>;

export const QueuePrSchema = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  state: z.string(),
  checks: z.string(),
  reviewState: z.string(),
});

export const QueueCiSchema = z.object({
  workflow: z.string(),
  url: z.string(),
  conclusion: z.string(),
  updatedMs: z.number(),
});

export const QueueItemSchema = z.object({
  taskId: z.number(),
  lane: LaneSchema,
  reason: WaitReasonSchema.nullable(),
  also: z.array(WaitReasonSchema),
  title: z.string(),
  repo: z.string(),
  branch: z.string(),
  folderDir: z.string(),
  sessionId: z.string().nullable(),
  said: z.string().nullable(),
  runningAgents: z.number(),
  pr: QueuePrSchema.nullable(),
  ci: z.array(QueueCiSchema),
  rank: z.number(),
  sinceMs: z.number().nullable(),
  snoozedUntilMs: z.number().nullable(),
  snoozed: z.boolean(),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const TaskQueueSchema = z.object({
  next: z.number().nullable(),
  items: z.array(QueueItemSchema),
});
export type TaskQueue = z.infer<typeof TaskQueueSchema>;
