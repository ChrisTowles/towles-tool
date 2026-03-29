import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { repositories, cards } from "../cards/schema";

export const workspaceSlots = sqliteTable("workspace_slots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repositories.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  portConfig: text("port_config"),
  envPath: text("env_path"),
  status: text("status", { enum: ["available", "claimed", "locked"] }).default("available"),
  claimedByCardId: integer("claimed_by_card_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const workflowRuns = sqliteTable("workflow_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  workflowId: text("workflow_id").notNull(),
  slotId: integer("slot_id").references(() => workspaceSlots.id, { onDelete: "set null" }),
  tmuxSession: text("tmux_session"),
  remoteSessionId: text("remote_session_id"),
  remoteSessionUrl: text("remote_session_url"),
  branch: text("branch"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  status: text("status", { enum: ["running", "completed", "failed", "cancelled"] }).default(
    "running",
  ),
});

export const stepRuns = sqliteTable("step_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workflowRunId: integer("workflow_run_id")
    .notNull()
    .references(() => workflowRuns.id, { onDelete: "cascade" }),
  stepId: text("step_id").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }),
  endedAt: integer("ended_at", { mode: "timestamp" }),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed", "skipped"],
  }).default("pending"),
  artifactPath: text("artifact_path"),
  retryNumber: integer("retry_number").default(0),
});

export const agentLogs = sqliteTable("agent_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workflowRunId: integer("workflow_run_id")
    .notNull()
    .references(() => workflowRuns.id, { onDelete: "cascade" }),
  stepId: text("step_id"),
  timestamp: integer("timestamp", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  stream: text("stream", { enum: ["stdout", "stderr"] }).default("stdout"),
  content: text("content").notNull(),
});
