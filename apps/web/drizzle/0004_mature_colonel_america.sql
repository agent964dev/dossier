CREATE TABLE `document_edit_links` (
	`document_id` text PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`created_by_account_id` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `document_state` (
	`document_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text,
	`bytes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `document_state_fields` (
	`document_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`value_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`document_id`, `name`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_state_fields_type_check" CHECK("document_state_fields"."type" IN ('text', 'textarea', 'number', 'date', 'checkbox', 'radio', 'select', 'select-multiple', 'json'))
);
--> statement-breakpoint
CREATE TABLE `document_state_grants` (
	`document_id` text NOT NULL,
	`email` text NOT NULL,
	`can_save` integer DEFAULT 1 NOT NULL,
	`created_by_account_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`document_id`, `email`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "document_state_grants_can_save_check" CHECK("document_state_grants"."can_save" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `document_state_grants_email_idx` ON `document_state_grants` (`email`);--> statement-breakpoint
ALTER TABLE `document_versions` ADD `state_fields_json` text;--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_documents` (
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
	`stateful` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deletion_batch_id`) REFERENCES `deletion_batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "documents_id_check" CHECK(length("__new_documents"."id") = 12 AND "__new_documents"."id" NOT GLOB '*[^a-z0-9]*'),
	CONSTRAINT "documents_depth_check" CHECK("__new_documents"."depth" BETWEEN 0 AND 16),
	CONSTRAINT "documents_kind_check" CHECK("__new_documents"."kind" IS NULL OR (length("__new_documents"."kind") BETWEEN 1 AND 32 AND "__new_documents"."kind" NOT GLOB '*[^a-z0-9-]*')),
	CONSTRAINT "documents_visibility_check" CHECK("__new_documents"."visibility" IS NULL OR "__new_documents"."visibility" IN ('public', 'team', 'private')),
	CONSTRAINT "documents_stateful_check" CHECK("__new_documents"."stateful" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "workspace_id", "created_by", "parent_id", "path", "depth", "kind", "title", "description", "visibility", "current_version_id", "next_version_number", "revision", "created_at", "updated_at", "deleted_at", "deletion_batch_id", "disabled_at", "disabled_reason", "stateful") SELECT "id", "workspace_id", "created_by", "parent_id", "path", "depth", "kind", "title", "description", "visibility", "current_version_id", "next_version_number", "revision", "created_at", "updated_at", "deleted_at", "deletion_batch_id", "disabled_at", "disabled_reason", 0 FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE INDEX `documents_path_binary_idx` ON `documents` ("path" COLLATE BINARY);--> statement-breakpoint
CREATE INDEX `documents_parent_deleted_idx` ON `documents` (`parent_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `documents_workspace_deleted_updated_idx` ON `documents` (`workspace_id`,`deleted_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `documents_created_by_deleted_updated_idx` ON `documents` (`created_by`,`deleted_at`,`updated_at`);