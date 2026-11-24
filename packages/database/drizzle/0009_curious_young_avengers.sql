CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_group_name_uq` ON `workspaces` (`group_id`,`name`);--> statement-breakpoint
CREATE INDEX `workspaces_group_created_idx` ON `workspaces` (`group_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`thread_id` text,
	`source_message_id` text,
	`idempotency_key` text,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`assigned_agent_id` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`result` text,
	`summary` text,
	`error` text,
	`workspace_id` text,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "group_id", "thread_id", "source_message_id", "idempotency_key", "title", "description", "status", "priority", "assigned_agent_id", "created_by_user_id", "created_at", "updated_at", "started_at", "completed_at", "cancelled_at", "result", "summary", "error", "workspace_id") SELECT "id", "group_id", "thread_id", "source_message_id", "idempotency_key", "title", "description", "status", "priority", "assigned_agent_id", "created_by_user_id", "created_at", "updated_at", "started_at", "completed_at", "cancelled_at", "result", "summary", "error", "workspace_id" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_group_idx` ON `tasks` (`group_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_thread_idx` ON `tasks` (`thread_id`);--> statement-breakpoint
CREATE INDEX `tasks_assignee_idx` ON `tasks` (`assigned_agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_group_idempotency_uq` ON `tasks` (`group_id`,`idempotency_key`);