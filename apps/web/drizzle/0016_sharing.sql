CREATE TABLE `page_needs` (
	`tree_id` text NOT NULL,
	`page_path` text NOT NULL,
	`need_path` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`tree_id`, `page_path`, `need_path`, `kind`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "page_needs_kind_check" CHECK("page_needs"."kind" in ('render', 'folder', 'json'))
);
--> statement-breakpoint
CREATE INDEX `page_needs_need_idx` ON `page_needs` (`tree_id`,`need_path`);--> statement-breakpoint
CREATE TABLE `page_views` (
	`node_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`node_id`, `day`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `pushes` ADD `shares_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `view_handles_anon_tree_unique` ON `view_handles` (`anon_session_id`,`tree_id`);