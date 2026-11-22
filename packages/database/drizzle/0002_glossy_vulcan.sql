DROP INDEX `agent_deliveries_pending_idx`;--> statement-breakpoint
CREATE INDEX `agent_deliveries_pending_idx` ON `agent_deliveries` (`agent_id`,`status`,`created_at`);--> statement-breakpoint
DROP INDEX `group_members_group_idx`;--> statement-breakpoint
CREATE INDEX `group_members_group_idx` ON `group_members` (`group_id`,`joined_at`);--> statement-breakpoint
DROP INDEX `tasks_group_idx`;--> statement-breakpoint
CREATE INDEX `tasks_group_idx` ON `tasks` (`group_id`,`created_at`,`id`);