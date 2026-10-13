CREATE TABLE `path_aliases` (
	`tree_id` text NOT NULL,
	`old_path` text NOT NULL,
	`node_id` text NOT NULL,
	`moved_at_seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tree_id`, `old_path`, `moved_at_seq`, `node_id`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `path_aliases_node_idx` ON `path_aliases` (`node_id`,`moved_at_seq`);--> statement-breakpoint
CREATE TABLE `purge_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`started_by` text,
	`state` text NOT NULL,
	`lease_until` integer NOT NULL,
	`checkpoint_json` text DEFAULT '{}' NOT NULL,
	`counts_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`started_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "purge_runs_trigger_check" CHECK("purge_runs"."trigger" in ('weekly', 'manual')),
	CONSTRAINT "purge_runs_state_check" CHECK("purge_runs"."state" in ('running', 'done', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `purge_runs_started_idx` ON `purge_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `tree_aliases` (
	`workspace_name` text NOT NULL,
	`tree_name` text NOT NULL,
	`tree_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_name`, `tree_name`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tree_aliases_tree_idx` ON `tree_aliases` (`tree_id`);--> statement-breakpoint
ALTER TABLE `events` ADD `detail` text;--> statement-breakpoint
ALTER TABLE `pushes` ADD `authored_seq` integer;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `purged_at` integer;