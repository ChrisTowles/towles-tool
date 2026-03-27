CREATE TABLE `agent_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` integer NOT NULL,
	`step_id` text,
	`timestamp` integer NOT NULL,
	`stream` text DEFAULT 'stdout',
	`content` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text DEFAULT 'Default' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`repo_id` integer,
	`column` text DEFAULT 'backlog',
	`position` integer DEFAULT 0 NOT NULL,
	`execution_mode` text DEFAULT 'headless',
	`status` text DEFAULT 'idle',
	`plan_id` integer,
	`depends_on` text,
	`workflow_id` text,
	`github_issue_number` integer,
	`github_pr_number` integer,
	`current_step_id` text,
	`retry_count` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`pr_granularity` text DEFAULT 'per_card',
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`org` text,
	`default_branch` text DEFAULT 'main',
	`github_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `step_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` integer NOT NULL,
	`step_id` text NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`status` text DEFAULT 'pending',
	`artifact_path` text,
	`retry_number` integer DEFAULT 0,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`workflow_id` text NOT NULL,
	`slot_id` integer,
	`tmux_session` text,
	`branch` text,
	`started_at` integer,
	`ended_at` integer,
	`status` text DEFAULT 'running',
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `workspace_slots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspace_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`path` text NOT NULL,
	`port_config` text,
	`env_path` text,
	`status` text DEFAULT 'available',
	`claimed_by_card_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repositories`(`id`) ON UPDATE no action ON DELETE no action
);
