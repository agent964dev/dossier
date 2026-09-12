CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`deployment_admin` integer DEFAULT 0 NOT NULL,
	`disabled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "accounts_kind_check" CHECK("accounts"."kind" IN ('user', 'service')),
	CONSTRAINT "accounts_deployment_admin_check" CHECK("accounts"."deployment_admin" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `allowlist` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`workspace_id` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "allowlist_kind_check" CHECK("allowlist"."kind" IN ('email', 'domain')),
	CONSTRAINT "allowlist_role_check" CHECK("allowlist"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allowlist_value_unique` ON `allowlist` (`value`);--> statement-breakpoint
CREATE INDEX `allowlist_value_idx` ON `allowlist` (`value`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_account_id_idx` ON `api_keys` (`account_id`);--> statement-breakpoint
CREATE TABLE `asset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`content_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`created_at` text NOT NULL,
	`created_by_api_key_id` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_versions_object_key_unique` ON `asset_versions` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `asset_versions_asset_number_unique` ON `asset_versions` (`asset_id`,`version_number`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by` text NOT NULL,
	`slug` text NOT NULL,
	`ext` text NOT NULL,
	`current_version_id` text,
	`next_version_number` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assets_slug_check" CHECK(length("assets"."slug") BETWEEN 1 AND 64 AND "assets"."slug" GLOB '[a-z0-9]*' AND "assets"."slug" NOT GLOB '*[^a-z0-9-]*'),
	CONSTRAINT "assets_ext_check" CHECK("assets"."ext" IN ('css', 'woff2'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_slug_unique` ON `assets` (`slug`);--> statement-breakpoint
CREATE TABLE `deletion_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`root_document_id` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` text NOT NULL,
	`restored_at` text,
	`deleted_count` integer NOT NULL,
	FOREIGN KEY (`root_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `document_shares` (
	`document_id` text NOT NULL,
	`email` text NOT NULL,
	`created_by_account_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`document_id`, `email`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `document_shares_email_idx` ON `document_shares` (`email`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`object_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`created_at` text NOT NULL,
	`created_by_account_id` text NOT NULL,
	`created_by_api_key_id` text,
	`user_agent` text,
	`cli_version` text,
	`git_branch` text,
	`git_commit_sha` text,
	`git_commit_subject` text,
	`git_dirty` integer,
	`original_filename` text,
	`has_inline_script` integer NOT NULL,
	`external_image_hosts` text,
	`stylesheet_refs` text,
	`ci_run_url` text,
	`ci_actor` text,
	`idempotency_key` text,
	`request_hash` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_versions_git_dirty_check" CHECK("document_versions"."git_dirty" IS NULL OR "document_versions"."git_dirty" IN (0, 1)),
	CONSTRAINT "document_versions_has_inline_script_check" CHECK("document_versions"."has_inline_script" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_object_key_unique` ON `document_versions` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_document_number_unique` ON `document_versions` (`document_id`,`version_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `document_versions_api_key_idempotency_unique` ON `document_versions` (`created_by_api_key_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by` text NOT NULL,
	`parent_id` text,
	`path` text NOT NULL,
	`depth` integer NOT NULL,
	`kind` text,
	`title` text NOT NULL,
	`description` text,
	`visibility` text,
	`current_version_id` text,
	`next_version_number` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`deletion_batch_id` text,
	`disabled_at` text,
	`disabled_reason` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deletion_batch_id`) REFERENCES `deletion_batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_id_check" CHECK(length("documents"."id") = 12 AND "documents"."id" NOT GLOB '*[^a-z0-9]*'),
	CONSTRAINT "documents_depth_check" CHECK("documents"."depth" BETWEEN 0 AND 16),
	CONSTRAINT "documents_kind_check" CHECK("documents"."kind" IS NULL OR (length("documents"."kind") BETWEEN 1 AND 32 AND "documents"."kind" NOT GLOB '*[^a-z0-9-]*')),
	CONSTRAINT "documents_visibility_check" CHECK("documents"."visibility" IS NULL OR "documents"."visibility" IN ('public', 'team', 'private'))
);
--> statement-breakpoint
CREATE INDEX `documents_path_binary_idx` ON `documents` ("path" COLLATE BINARY);--> statement-breakpoint
CREATE INDEX `documents_parent_deleted_idx` ON `documents` (`parent_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `documents_workspace_deleted_updated_idx` ON `documents` (`workspace_id`,`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `documents_created_by_deleted_updated_idx` ON `documents` (`created_by`,`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`display_name` text,
	`picture_url` text,
	`pii_subject` text,
	`created_at` text NOT NULL,
	`last_login_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "identities_email_verified_check" CHECK("identities"."email_verified" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `identities_account_id_idx` ON `identities` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `identities_provider_subject_unique` ON `identities` (`provider`,`subject`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `account_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memberships_role_check" CHECK("memberships"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE INDEX `memberships_account_id_idx` ON `memberships` (`account_id`);--> statement-breakpoint
CREATE TABLE `upload_events` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text,
	`document_version_id` text,
	`account_id` text,
	`api_key_id` text,
	`event_type` text NOT NULL,
	`metadata_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`document_version_id`) REFERENCES `document_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `upload_events_document_created_idx` ON `upload_events` (`document_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`email_domain` text,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "workspaces_kind_check" CHECK("workspaces"."kind" IN ('team', 'personal'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slug_unique` ON `workspaces` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_email_domain_unique` ON `workspaces` (`email_domain`);