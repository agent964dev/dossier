CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_account_unique` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `agent_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`hash_sha256` text NOT NULL,
	`created_via` text NOT NULL,
	`google_account_id` text,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_keys_created_via_check" CHECK("agent_keys"."created_via" in ('device', 'settings'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_keys_hash_sha256_unique` ON `agent_keys` (`hash_sha256`);--> statement-breakpoint
CREATE INDEX `agent_keys_user_idx` ON `agent_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `device_code` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text,
	`device_name` text,
	`grant_kind` text,
	`approved_by_google_account_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_device_code_unique` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_user_code_unique` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE TABLE `google_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_authority` text NOT NULL,
	`hosted_domain` text,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "google_accounts_email_authority_check" CHECK("google_accounts"."email_authority" in ('google', 'none'))
);
--> statement-breakpoint
CREATE TABLE `people` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email_authority` text NOT NULL,
	`first_sign_in_at` integer NOT NULL,
	`last_sign_in_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "people_email_authority_check" CHECK("people"."email_authority" in ('google', 'none'))
);
--> statement-breakpoint
CREATE TABLE `person_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "person_history_kind_check" CHECK("person_history"."kind" in ('linked', 'takeover', 'email_kept', 'signed_out_everywhere', 'key_created', 'key_revoked'))
);
--> statement-breakpoint
CREATE INDEX `person_history_user_idx` ON `person_history` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `rate_limit` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`google_account_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `super_admins` (
	`user_id` text PRIMARY KEY NOT NULL,
	`added_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`added_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);