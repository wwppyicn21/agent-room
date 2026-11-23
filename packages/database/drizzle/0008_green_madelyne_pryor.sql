CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`thread_id` text,
	`requested_by_agent_id` text NOT NULL,
	`title` text NOT NULL,
	`details` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by_user_id` text,
	`decided_at` integer,
	`reason` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`requested_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `approvals_task_idx` ON `approvals` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`);--> statement-breakpoint
ALTER TABLE `task_runs` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `progress_percent` integer;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `progress_stage` text;--> statement-breakpoint
ALTER TABLE `task_runs` ADD `progress_message` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cancelled_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `result` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `error` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `workspace_id` text;