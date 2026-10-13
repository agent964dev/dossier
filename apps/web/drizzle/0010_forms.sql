CREATE TABLE `forms` (
	`host_version_id` text NOT NULL,
	`host_node_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`target_path` text NOT NULL,
	`form_key` text NOT NULL,
	`kind` text NOT NULL,
	`closes_at` integer,
	`closed` integer NOT NULL,
	`line` integer NOT NULL,
	`title` text,
	`schema_json` text NOT NULL,
	PRIMARY KEY(`host_version_id`, `target_path`, `form_key`),
	FOREIGN KEY (`host_version_id`) REFERENCES `node_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`host_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "forms_kind_check" CHECK("forms"."kind" in ('person', 'entries', 'shared'))
);
--> statement-breakpoint
CREATE INDEX `forms_tree_target_idx` ON `forms` (`tree_id`,`target_path`);--> statement-breakpoint
CREATE INDEX `forms_host_node_idx` ON `forms` (`host_node_id`);--> statement-breakpoint
CREATE TABLE `push_forms` (
	`push_id` text NOT NULL,
	`path` text NOT NULL,
	`target_path` text NOT NULL,
	`form_key` text NOT NULL,
	`kind` text NOT NULL,
	`closes_at` integer,
	`closed` integer NOT NULL,
	`line` integer NOT NULL,
	`title` text,
	`schema_json` text NOT NULL,
	PRIMARY KEY(`push_id`, `path`, `target_path`, `form_key`),
	FOREIGN KEY (`push_id`) REFERENCES `pushes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_change_guards` (
	`id` text NOT NULL,
	`reason` text NOT NULL,
	`ok` integer,
	PRIMARY KEY(`id`, `reason`),
	CONSTRAINT "change_guard_head" CHECK("__new_change_guards"."reason" <> 'head' or "__new_change_guards"."ok" = 1),
	CONSTRAINT "change_guard_basis" CHECK("__new_change_guards"."reason" <> 'basis' or "__new_change_guards"."ok" = 1),
	CONSTRAINT "change_guard_blob" CHECK("__new_change_guards"."reason" <> 'blob' or "__new_change_guards"."ok" = 1),
	CONSTRAINT "change_guard_state" CHECK("__new_change_guards"."reason" <> 'state' or "__new_change_guards"."ok" = 1),
	CONSTRAINT "change_guard_mergeable" CHECK("__new_change_guards"."reason" <> 'mergeable' or "__new_change_guards"."ok" = 1),
	CONSTRAINT "change_guard_size" CHECK("__new_change_guards"."reason" <> 'size' or "__new_change_guards"."ok" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_change_guards`("id", "reason", "ok") SELECT "id", "reason", "ok" FROM `change_guards`;--> statement-breakpoint
DROP TABLE `change_guards`;--> statement-breakpoint
ALTER TABLE `__new_change_guards` RENAME TO `change_guards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;