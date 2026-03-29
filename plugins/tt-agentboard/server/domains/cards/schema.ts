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
    .references(() => boards.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  repoId: integer("repo_id").references(() => repositories.id, { onDelete: "set null" }),
  column: text("column", {
    enum: ["backlog", "ready", "in_progress", "simplify_review", "review", "done"],
  }).default("ready"),
  position: integer("position").notNull().default(0),
  executionMode: text("execution_mode", { enum: ["headless", "interactive", "remote"] }).default(
    "headless",
  ),
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
  planId: integer("plan_id").references(() => plans.id, { onDelete: "set null" }),
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

export const cardDependencies = sqliteTable("card_dependencies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  dependsOnCardId: integer("depends_on_card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
});

export const cardEvents = sqliteTable("card_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  detail: text("detail"),
  timestamp: integer("timestamp", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
