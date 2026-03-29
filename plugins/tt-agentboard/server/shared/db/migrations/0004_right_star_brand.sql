PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`repo_id` integer,
	`column` text DEFAULT 'ready',
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
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `remote_session_id` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `remote_session_url` text;