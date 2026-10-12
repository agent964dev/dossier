CREATE TABLE `mentions` (
	`tree_id` text NOT NULL,
	`event_seq` integer NOT NULL,
	`comment_node_id` text NOT NULL,
	`page_node_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tree_id`, `event_seq`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`page_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mentions_email_idx` ON `mentions` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `mentions_page_idx` ON `mentions` (`page_node_id`);--> statement-breakpoint
CREATE INDEX `mentions_comment_idx` ON `mentions` (`comment_node_id`);