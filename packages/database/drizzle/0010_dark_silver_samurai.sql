CREATE TABLE `agent_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`command_type` text NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`acked_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `task_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_commands_task_uq` ON `agent_commands` (`agent_id`,`command_type`,`task_id`);--> statement-breakpoint
CREATE INDEX `agent_commands_agent_status_idx` ON `agent_commands` (`agent_id`,`status`,`created_at`);