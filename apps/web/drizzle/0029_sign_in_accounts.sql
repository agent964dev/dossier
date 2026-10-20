-- The schema stops naming Google where it means a sign-in account, and keeps
-- every row. SQLite cannot change a CHECK in place, so the tables whose
-- checks widen are rebuilt and their rows copied; no table points at them.
-- `session` is renamed in place, because `view_handles` points at it, and its
-- triggers are written again on the new column name.
--
-- The Worker running before this release reads the old names, so sessions and
-- sign-ins fail between this migration and the new Worker going live.
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `account_emails` (
	`account_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_authority` text NOT NULL,
	`organisation` text,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_emails_email_authority_check" CHECK("account_emails"."email_authority" in ('google', 'microsoft', 'none'))
);
--> statement-breakpoint
INSERT INTO `account_emails`("account_id", "email", "email_authority", "organisation", "observed_at") SELECT "account_id", "email", "email_authority", "hosted_domain", "observed_at" FROM `google_accounts`;--> statement-breakpoint
DROP TABLE `google_accounts`;--> statement-breakpoint
CREATE TABLE `__new_people` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email_authority` text NOT NULL,
	`first_sign_in_at` integer NOT NULL,
	`last_sign_in_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "people_email_authority_check" CHECK("__new_people"."email_authority" in ('google', 'microsoft', 'none'))
);
--> statement-breakpoint
INSERT INTO `__new_people`("user_id", "email_authority", "first_sign_in_at", "last_sign_in_at", "deleted_at") SELECT "user_id", "email_authority", "first_sign_in_at", "last_sign_in_at", "deleted_at" FROM `people`;--> statement-breakpoint
DROP TABLE `people`;--> statement-breakpoint
ALTER TABLE `__new_people` RENAME TO `people`;--> statement-breakpoint
CREATE TABLE `__new_person_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "person_history_kind_check" CHECK("__new_person_history"."kind" in ('linked', 'takeover', 'email_kept', 'signed_out_everywhere', 'key_created', 'key_revoked', 'deleted', 'returned', 'disconnected'))
);
--> statement-breakpoint
INSERT INTO `__new_person_history`("id", "user_id", "kind", "detail_json", "created_at") SELECT "id", "user_id", "kind", "detail_json", "created_at" FROM `person_history`;--> statement-breakpoint
DROP TABLE `person_history`;--> statement-breakpoint
ALTER TABLE `__new_person_history` RENAME TO `person_history`;--> statement-breakpoint
CREATE INDEX `person_history_user_idx` ON `person_history` (`user_id`,`created_at`);--> statement-breakpoint
DROP TRIGGER `session_requires_attached_account`;--> statement-breakpoint
DROP TRIGGER `account_removal_ends_sessions`;--> statement-breakpoint
ALTER TABLE `session` RENAME COLUMN `google_account_id` TO `sign_in_account_id`;--> statement-breakpoint
ALTER TABLE `agent_keys` RENAME COLUMN `google_account_id` TO `created_by_account_id`;--> statement-breakpoint
ALTER TABLE `device_code` RENAME COLUMN `approved_by_google_account_id` TO `approved_by_account_id`;--> statement-breakpoint
-- A session rests on the sign-in account that opened it: it can be written
-- only while that account belongs to its person, and it ends when the account
-- goes. A takeover's batch and a late sign-in of the account it detaches can
-- then never leave a session behind, whichever reads it.
CREATE TRIGGER `session_requires_attached_account`
BEFORE INSERT ON `session`
WHEN NEW.`sign_in_account_id` IS NULL OR NOT EXISTS (
  SELECT 1 FROM `account`
  WHERE `account`.`id` = NEW.`sign_in_account_id` AND `account`.`user_id` = NEW.`user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'session_account_detached');
END;
--> statement-breakpoint
CREATE TRIGGER `account_removal_ends_sessions`
AFTER DELETE ON `account`
BEGIN
  DELETE FROM `session` WHERE `sign_in_account_id` = OLD.`id`;
END;
