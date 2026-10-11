CREATE TABLE `seen_by` (
	`node_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`node_id`, `user_id`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `view_handle_seqs` (
	`handle_hash` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`handle_hash`, `seq`),
	FOREIGN KEY (`handle_hash`) REFERENCES `view_handles`(`hash_sha256`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `view_handles` (
	`hash_sha256` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`user_id` text,
	`session_id` text,
	`anon_session_id` text,
	`tree_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`renewed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "view_handles_owner_check" CHECK(("view_handles"."session_id" is null) <> ("view_handles"."anon_session_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `view_handles_session_tree_unique` ON `view_handles` (`session_id`,`tree_id`);--> statement-breakpoint
CREATE INDEX `view_handles_expires_idx` ON `view_handles` (`expires_at`);