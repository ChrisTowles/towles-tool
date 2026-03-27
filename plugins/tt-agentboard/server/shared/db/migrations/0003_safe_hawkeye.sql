CREATE TABLE `card_dependencies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`depends_on_card_id` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` integer NOT NULL,
	`step_id` text,
	`timestamp` integer NOT NULL,
	`stream` text DEFAULT 'stdout',
	`content` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_agent_logs`("id", "workflow_run_id", "step_id", "timestamp", "stream", "content") SELECT "id", "workflow_run_id", "step_id", "timestamp", "stream", "content" FROM `agent_logs`;--> statement-breakpoint
DROP TABLE `agent_logs`;--> statement-breakpoint
ALTER TABLE `__new_agent_logs` RENAME TO `agent_logs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_card_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`event` text NOT NULL,
	`detail` text,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_card_events`("id", "card_id", "event", "detail", "timestamp") SELECT "id", "card_id", "event", "detail", "timestamp" FROM `card_events`;--> statement-breakpoint
DROP TABLE `card_events`;--> statement-breakpoint
ALTER TABLE `__new_card_events` RENAME TO `card_events`;--> statement-breakpoint
CREATE TABLE `__new_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`repo_id` integer,
	`column` text DEFAULT 'backlog',
	`position` integer DEFAULT 0 NOT NULL,
	`execution_mode` text DEFAULT 'headless',
	`branch_mode` text DEFAULT 'create',
	`status` text DEFAULT 'idle',
	`plan_id` integer,
	`workflow_id` text,
	`github_issue_number` integer,
	`github_pr_number` integer,
	`current_step_id` text,
	`retry_count` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_cards`("id", "board_id", "title", "description", "repo_id", "column", "position", "execution_mode", "branch_mode", "status", "plan_id", "workflow_id", "github_issue_number", "github_pr_number", "current_step_id", "retry_count", "created_at", "updated_at") SELECT "id", "board_id", "title", "description", "repo_id", "column", "position", "execution_mode", "branch_mode", "status", "plan_id", "workflow_id", "github_issue_number", "github_pr_number", "current_step_id", "retry_count", "created_at", "updated_at" FROM `cards`;--> statement-breakpoint
DROP TABLE `cards`;--> statement-breakpoint
ALTER TABLE `__new_cards` RENAME TO `cards`;--> statement-breakpoint
CREATE TABLE `__new_step_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` integer NOT NULL,
	`step_id` text NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`status` text DEFAULT 'pending',
	`artifact_path` text,
	`retry_number` integer DEFAULT 0,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_step_runs`("id", "workflow_run_id", "step_id", "started_at", "ended_at", "status", "artifact_path", "retry_number") SELECT "id", "workflow_run_id", "step_id", "started_at", "ended_at", "status", "artifact_path", "retry_number" FROM `step_runs`;--> statement-breakpoint
DROP TABLE `step_runs`;--> statement-breakpoint
ALTER TABLE `__new_step_runs` RENAME TO `step_runs`;--> statement-breakpoint
CREATE TABLE `__new_workflow_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`workflow_id` text NOT NULL,
	`slot_id` integer,
	`tmux_session` text,
	`branch` text,
	`started_at` integer,
	`ended_at` integer,
	`status` text DEFAULT 'running',
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`slot_id`) REFERENCES `workspace_slots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_workflow_runs`("id", "card_id", "workflow_id", "slot_id", "tmux_session", "branch", "started_at", "ended_at", "status") SELECT "id", "card_id", "workflow_id", "slot_id", "tmux_session", "branch", "started_at", "ended_at", "status" FROM `workflow_runs`;--> statement-breakpoint
DROP TABLE `workflow_runs`;--> statement-breakpoint
ALTER TABLE `__new_workflow_runs` RENAME TO `workflow_runs`;--> statement-breakpoint
CREATE TABLE `__new_workspace_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`path` text NOT NULL,
	`port_config` text,
	`env_path` text,
	`status` text DEFAULT 'available',
	`claimed_by_card_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workspace_slots`("id", "repo_id", "path", "port_config", "env_path", "status", "claimed_by_card_id", "created_at") SELECT "id", "repo_id", "path", "port_config", "env_path", "status", "claimed_by_card_id", "created_at" FROM `workspace_slots`;--> statement-breakpoint
DROP TABLE `workspace_slots`;--> statement-breakpoint
ALTER TABLE `__new_workspace_slots` RENAME TO `workspace_slots`;