CREATE TABLE `webhook_deliveries` (
	`event_tree_id` text NOT NULL,
	`event_seq` integer NOT NULL,
	`webhook_id` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`claim_id` text,
	`claimed_until` integer,
	`last_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	PRIMARY KEY(`event_tree_id`, `event_seq`, `webhook_id`),
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "webhook_deliveries_state_check" CHECK("webhook_deliveries"."state" in ('pending', 'delivered', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_state_next_idx` ON `webhook_deliveries` (`state`,`next_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_created_idx` ON `webhook_deliveries` (`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_idx` ON `webhook_deliveries` (`webhook_id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`url` text NOT NULL,
	`events_json` text NOT NULL,
	`secret` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`failing_since` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_error_at` integer,
	`last_success_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhooks_workspace_idx` ON `webhooks` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);