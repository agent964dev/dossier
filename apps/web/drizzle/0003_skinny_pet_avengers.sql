PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_deletion_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`root_document_id` text NOT NULL,
	`account_id` text NOT NULL,
	`created_at` text NOT NULL,
	`restored_at` text,
	`deleted_count` integer NOT NULL,
	`root_title` text,
	`purge_status` text DEFAULT 'pending' NOT NULL,
	`purge_lease_until` text,
	`purge_progress` text,
	`purged_at` text,
	`purged_bytes` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deletion_batches_purge_status_check" CHECK("__new_deletion_batches"."purge_status" IN ('pending', 'claimed', 'purged'))
);
--> statement-breakpoint
INSERT INTO `__new_deletion_batches`("id", "root_document_id", "account_id", "created_at", "restored_at", "deleted_count", "root_title", "purge_status", "purge_lease_until", "purge_progress", "purged_at", "purged_bytes") SELECT "id", "root_document_id", "account_id", "created_at", "restored_at", "deleted_count", "root_title", 'pending', NULL, NULL, NULL, NULL FROM `deletion_batches`;--> statement-breakpoint
DROP TABLE `deletion_batches`;--> statement-breakpoint
ALTER TABLE `__new_deletion_batches` RENAME TO `deletion_batches`;--> statement-breakpoint
CREATE INDEX `deletion_batches_purge_status_created_at_idx` ON `deletion_batches` (`purge_status`,`created_at`);--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;
