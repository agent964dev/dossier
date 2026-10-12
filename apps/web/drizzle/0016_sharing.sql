CREATE TABLE `html_files` (
	`sha256` text PRIMARY KEY NOT NULL,
	`complete` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `page_views` (
	`node_id` text NOT NULL,
	`day` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`node_id`, `day`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `render_paths` (
	`sha256` text NOT NULL,
	`folder` text NOT NULL,
	`path` text NOT NULL,
	`inline` integer NOT NULL,
	PRIMARY KEY(`sha256`, `folder`, `path`, `inline`)
);
--> statement-breakpoint
ALTER TABLE `pushes` ADD `shares_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `view_handles_anon_tree_unique` ON `view_handles` (`anon_session_id`,`tree_id`);