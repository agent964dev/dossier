CREATE TABLE `view_handle_nodes` (
	`handle_hash` text NOT NULL,
	`seq` integer NOT NULL,
	`node_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`handle_hash`, `seq`, `node_id`),
	FOREIGN KEY (`handle_hash`) REFERENCES `view_handles`(`hash_sha256`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `view_handle_seqs`;