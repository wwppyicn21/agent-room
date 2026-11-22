ALTER TABLE `tasks` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_group_idempotency_uq` ON `tasks` (`group_id`,`idempotency_key`);