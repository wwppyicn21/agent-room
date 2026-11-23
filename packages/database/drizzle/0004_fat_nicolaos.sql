CREATE TABLE `agent_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`key_id` text NOT NULL,
	`nonce` text NOT NULL,
	`client_nonce` text NOT NULL,
	`purpose` text NOT NULL,
	`protocol_version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_challenges_nonce_uq` ON `agent_challenges` (`nonce`);--> statement-breakpoint
CREATE INDEX `agent_challenges_expiry_idx` ON `agent_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`key_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`closed_at` integer,
	`close_reason` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_token_uq` ON `agent_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `agent_sessions_agent_idx` ON `agent_sessions` (`agent_id`,`closed_at`);--> statement-breakpoint
CREATE INDEX `agent_sessions_expiry_idx` ON `agent_sessions` (`expires_at`);