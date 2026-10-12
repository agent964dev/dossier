CREATE TABLE `deployment_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deployment_settings_key_check" CHECK("deployment_settings"."key" in ('workspace_creation', 'limits', 'retention_days'))
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`team_ids_json` text DEFAULT '[]' NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `email`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invitations_email_idx` ON `invitations` (`email`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`grant_order` integer,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_members_user_idx` ON `team_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "teams_name_check" CHECK(length("teams"."name") between 1 and 60 and "teams"."name" = trim("teams"."name"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_workspace_name_unique` ON `teams` (`workspace_id`,lower("name"));--> statement-breakpoint
CREATE TABLE `workspace_creators` (
	`entry` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "workspace_creators_kind_check" CHECK("workspace_creators"."kind" in ('email', 'domain'))
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_person_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "person_history_kind_check" CHECK("__new_person_history"."kind" in ('linked', 'takeover', 'email_kept', 'signed_out_everywhere', 'key_created', 'key_revoked', 'deleted', 'returned'))
);
--> statement-breakpoint
INSERT INTO `__new_person_history`("id", "user_id", "kind", "detail_json", "created_at") SELECT "id", "user_id", "kind", "detail_json", "created_at" FROM `person_history`;--> statement-breakpoint
DROP TABLE `person_history`;--> statement-breakpoint
ALTER TABLE `__new_person_history` RENAME TO `person_history`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `person_history_user_idx` ON `person_history` (`user_id`,`created_at`);--> statement-breakpoint
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
	CONSTRAINT "change_guard_size" CHECK("__new_change_guards"."reason" <> 'size' or "__new_change_guards"."ok" = 1),
	CONSTRAINT "change_guard_admins" CHECK("__new_change_guards"."reason" <> 'admins' or "__new_change_guards"."ok" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_change_guards`("id", "reason", "ok") SELECT "id", "reason", "ok" FROM `change_guards`;--> statement-breakpoint
DROP TABLE `change_guards`;--> statement-breakpoint
ALTER TABLE `__new_change_guards` RENAME TO `change_guards`;--> statement-breakpoint
-- A place in a team is a grant: shares to the team reach its members. It is
-- stamped from grant_clock in the transaction that writes it, as shares and
-- workspace memberships are, so a view's first issuance can tell whether
-- the place existed then. Moving between teams deletes one row and inserts
-- another, which is a new grant.
CREATE TRIGGER `team_members_grant_order_on_insert`
AFTER INSERT ON `team_members`
BEGIN
  UPDATE `grant_clock` SET `value` = `value` + 1 WHERE `id` = 1;
  UPDATE `team_members` SET `grant_order` = (SELECT `value` FROM `grant_clock` WHERE `id` = 1)
  WHERE `team_id` = NEW.`team_id` AND `user_id` = NEW.`user_id`;
END;
