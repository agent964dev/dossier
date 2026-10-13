CREATE TABLE `analyses` (
	`sha256` text NOT NULL,
	`analyzer` text NOT NULL,
	`version` integer NOT NULL,
	`json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`sha256`, `analyzer`, `version`)
);
--> statement-breakpoint
CREATE TABLE `blob_holds` (
	`holder_kind` text NOT NULL,
	`holder_id` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`holder_kind`, `holder_id`, `sha256`),
	FOREIGN KEY (`sha256`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "blob_holds_kind_check" CHECK("blob_holds"."holder_kind" in ('push', 'restore', 'upload', 'move'))
);
--> statement-breakpoint
CREATE INDEX `blob_holds_sha_idx` ON `blob_holds` (`sha256`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'live' NOT NULL,
	`first_seen_at` integer NOT NULL,
	`reclaim_started_at` integer,
	CONSTRAINT "blobs_state_check" CHECK("blobs"."state" in ('live', 'reclaiming'))
);
--> statement-breakpoint
CREATE TABLE `change_guards` (
	`id` text NOT NULL,
	`reason` text NOT NULL,
	`ok` integer,
	PRIMARY KEY(`id`, `reason`),
	CONSTRAINT "change_guard_head" CHECK("change_guards"."reason" <> 'head' or "change_guards"."ok" = 1),
	CONSTRAINT "change_guard_basis" CHECK("change_guards"."reason" <> 'basis' or "change_guards"."ok" = 1),
	CONSTRAINT "change_guard_blob" CHECK("change_guards"."reason" <> 'blob' or "change_guards"."ok" = 1),
	CONSTRAINT "change_guard_state" CHECK("change_guards"."reason" <> 'state' or "change_guards"."ok" = 1)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`tree_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`node_id` text,
	`path` text NOT NULL,
	`actor_id` text,
	`push_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tree_id`, `seq`),
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`push_id`) REFERENCES `pushes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_type_check" CHECK("events"."type" in ('push', 'delete', 'restore', 'move', 'submission', 'entry', 'withdrawal', 'data_write', 'comment', 'mention', 'share'))
);
--> statement-breakpoint
CREATE TABLE `node_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`revision` integer NOT NULL,
	`authored_seq` integer,
	`state` text NOT NULL,
	`blob_sha256` text,
	`json_value` text,
	`size` integer,
	`content_type` text,
	`author_id` text NOT NULL,
	`key_id` text,
	`push_id` text,
	`seen_push_number` integer,
	`op_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blob_sha256`) REFERENCES `blobs`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`push_id`) REFERENCES `pushes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "node_versions_state_check" CHECK("node_versions"."state" in ('live', 'deleted', 'withdrawn')),
	CONSTRAINT "node_versions_content_check" CHECK(case when "node_versions"."state" = 'live'
    then ("node_versions"."blob_sha256" is null) <> ("node_versions"."json_value" is null)
    else "node_versions"."blob_sha256" is null and "node_versions"."json_value" is null end)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_versions_node_revision_unique` ON `node_versions` (`node_id`,`revision`);--> statement-breakpoint
CREATE INDEX `node_versions_node_seq_idx` ON `node_versions` (`node_id`,`authored_seq`);--> statement-breakpoint
CREATE INDEX `node_versions_tree_seq_idx` ON `node_versions` (`tree_id`,`authored_seq`);--> statement-breakpoint
CREATE INDEX `node_versions_blob_idx` ON `node_versions` (`blob_sha256`);--> statement-breakpoint
CREATE INDEX `node_versions_push_idx` ON `node_versions` (`push_id`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`depth` integer NOT NULL,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`owner_id` text,
	`current_version_id` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "nodes_kind_check" CHECK("nodes"."kind" in ('folder', 'file')),
	CONSTRAINT "nodes_origin_check" CHECK("nodes"."origin" in ('authored', 'data')),
	CONSTRAINT "nodes_owner_check" CHECK("nodes"."origin" = 'data' or "nodes"."owner_id" is null),
	CONSTRAINT "nodes_depth_check" CHECK("nodes"."depth" between 0 and 32)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_live_path_unique` ON `nodes` (`tree_id`,`path`) WHERE "nodes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `nodes_tree_path_idx` ON `nodes` (`tree_id`,`path`);--> statement-breakpoint
CREATE INDEX `nodes_parent_idx` ON `nodes` (`parent_id`);--> statement-breakpoint
CREATE TABLE `operations` (
	`principal` text NOT NULL,
	`scope` text NOT NULL,
	`op_id` text NOT NULL,
	`result_node_id` text,
	`result_version_id` text,
	`result_state` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`principal`, `scope`, `op_id`),
	CONSTRAINT "operations_result_state_check" CHECK("operations"."result_state" in ('stored', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE `push_files` (
	`push_id` text NOT NULL,
	`path` text NOT NULL,
	`parent_path` text NOT NULL,
	`name` text NOT NULL,
	`depth` integer NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text NOT NULL,
	PRIMARY KEY(`push_id`, `path`),
	FOREIGN KEY (`push_id`) REFERENCES `pushes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_folders` (
	`push_id` text NOT NULL,
	`path` text NOT NULL,
	`parent_path` text NOT NULL,
	`name` text NOT NULL,
	`depth` integer NOT NULL,
	PRIMARY KEY(`push_id`, `path`),
	FOREIGN KEY (`push_id`) REFERENCES `pushes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pushes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`tree_name` text NOT NULL,
	`tree_id` text,
	`path` text NOT NULL,
	`base_seq` integer,
	`number` integer,
	`message` text,
	`force` integer DEFAULT false NOT NULL,
	`author_id` text NOT NULL,
	`key_id` text,
	`state` text NOT NULL,
	`file_count` integer NOT NULL,
	`byte_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`committed_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`key_id`) REFERENCES `agent_keys`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pushes_state_check" CHECK("pushes"."state" in ('staged', 'committed', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pushes_tree_number_unique` ON `pushes` (`tree_id`,`number`);--> statement-breakpoint
CREATE INDEX `pushes_state_expires_idx` ON `pushes` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `rate_counters` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`tree_id` text NOT NULL,
	`node_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shares_target_kind_check" CHECK("shares"."target_kind" in ('email', 'team', 'workspace', 'anyone')),
	CONSTRAINT "shares_role_check" CHECK("shares"."role" in ('read', 'respond', 'write'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_node_target_unique` ON `shares` (`node_id`,`target_kind`,`target`);--> statement-breakpoint
CREATE INDEX `shares_tree_idx` ON `shares` (`tree_id`);--> statement-breakpoint
CREATE INDEX `shares_target_idx` ON `shares` (`target_kind`,`target`);--> statement-breakpoint
CREATE TABLE `trees` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`root_node_id` text NOT NULL,
	`created_by` text NOT NULL,
	`authored_seq` integer DEFAULT 0 NOT NULL,
	`event_seq` integer DEFAULT 0 NOT NULL,
	`push_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trees_name_check" CHECK(length("trees"."name") between 1 and 63 and "trees"."name" not glob '*[^a-z0-9-]*' and "trees"."name" not glob '-*'),
	CONSTRAINT "trees_id_check" CHECK(length("trees"."id") = 20 and "trees"."id" not glob '*[^a-z0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trees_workspace_name_unique` ON `trees` (`workspace_id`,`name`) WHERE "trees"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_members_role_check" CHECK("workspace_members"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE INDEX `workspace_members_user_idx` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`suspended_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspaces_name_check" CHECK(length("workspaces"."name") between 1 and 63 and "workspaces"."name" not glob '*[^a-z0-9-]*' and "workspaces"."name" not glob '-*' and "workspaces"."name" not in ('api', 'cli'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_name_unique` ON `workspaces` (`name`);--> statement-breakpoint
ALTER TABLE `agent_keys` ADD `scope_node_id` text REFERENCES nodes(id);--> statement-breakpoint
ALTER TABLE `agent_keys` ADD `read_only` integer DEFAULT false NOT NULL;