import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const repositories = sqliteTable("repositories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  org: text("org"),
  defaultBranch: text("default_branch").default("main"),
  githubUrl: text("github_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const workspaceSlots = sqliteTable("workspace_slots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoId: integer("repo_id")
    .notNull()
    .references(() => repositories.id),
  path: text("path").notNull(),
  portConfig: text("port_config"),
  envPath: text("env_path"),
  status: text("status", { enum: ["available", "claimed", "locked"] }).default("available"),
  claimedByCardId: integer("claimed_by_card_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const boards = sqliteTable("boards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().default("Default"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  prGranularity: text("pr_granularity", { enum: ["per_card", "per_plan"] }).default("per_card"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const cards = sqliteTable("cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  boardId: integer("board_id")
    .notNull()
    .references(() => boards.id),
  title: text("title").notNull(),
  description: text("description"),
  repoId: integer("repo_id").references(() => repositories.id),
  column: text("column", { enum: ["backlog", "ready", "in_progress", "review", "done"] }).default(
    "backlog",
  ),
  position: integer("position").notNull().default(0),
  executionMode: text("execution_mode", { enum: ["headless", "interactive"] }).default("headless"),
  branchMode: text("branch_mode", { enum: ["create", "current"] }).default("create"),
  status: text("status", {
    enum: [
      "idle",
      "queued",
      "running",
      "waiting_input",
      "review_ready",
      "done",
      "failed",
      "blocked",
    ],
  }).default("idle"),
  planId: integer("plan_id").references(() => plans.id),
  dependsOn: text("depends_on"),
  workflowId: text("workflow_id"),
  githubIssueNumber: integer("github_issue_number"),
  githubPrNumber: integer("github_pr_number"),
  currentStepId: text("current_step_id"),
  retryCount: integer("retry_count").default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const workflowRuns = sqliteTable("workflow_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => cards.id),
  workflowId: text("workflow_id").notNull(),
  slotId: integer("slot_id").references(() => workspaceSlots.id),
  tmuxSession: text("tmux_session"),
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
    .references(() => workflowRuns.id),
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
    .references(() => workflowRuns.id),
  stepId: text("step_id"),
  timestamp: integer("timestamp", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  stream: text("stream", { enum: ["stdout", "stderr"] }).default("stdout"),
  content: text("content").notNull(),
});
