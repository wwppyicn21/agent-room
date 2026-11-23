CREATE TABLE `agent_socket_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ticket_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_socket_tickets_hash_uq` ON `agent_socket_tickets` (`ticket_hash`);--> statement-breakpoint
CREATE INDEX `agent_socket_tickets_expiry_idx` ON `agent_socket_tickets` (`expires_at`);--> statement-breakpoint
CREATE INDEX `agent_socket_tickets_session_idx` ON `agent_socket_tickets` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_lower_uq` ON `users` (lower("email"));