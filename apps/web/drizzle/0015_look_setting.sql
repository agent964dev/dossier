PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_deployment_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deployment_settings_key_check" CHECK("__new_deployment_settings"."key" in ('workspace_creation', 'limits', 'retention_days', 'look'))
);
--> statement-breakpoint
INSERT INTO `__new_deployment_settings`("key", "value_json", "updated_by", "updated_at") SELECT "key", "value_json", "updated_by", "updated_at" FROM `deployment_settings`;--> statement-breakpoint
DROP TABLE `deployment_settings`;--> statement-breakpoint
ALTER TABLE `__new_deployment_settings` RENAME TO `deployment_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;