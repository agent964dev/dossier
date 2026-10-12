CREATE TABLE `grant_clock` (
	`id` integer PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	CONSTRAINT "grant_clock_one_row" CHECK("grant_clock"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `view_handle_firsts` (
	`handle_hash` text NOT NULL,
	`seq` integer NOT NULL,
	`grant_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`handle_hash`, `seq`),
	FOREIGN KEY (`handle_hash`) REFERENCES `view_handles`(`hash_sha256`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `shares` ADD `grant_order` integer;--> statement-breakpoint
ALTER TABLE `workspace_members` ADD `grant_order` integer;--> statement-breakpoint
-- Grants are ordered by commit, not by the clock of the request that made
-- them: one counter row moves in the transaction that writes a grant, and
-- the grant takes its value. A view records the counter when it first
-- issues a sequence, so "the grant existed then" is a comparison of orders.
-- Grants written before this migration count as existing from the start.
INSERT INTO `grant_clock` (`id`, `value`) VALUES (1, 0);
--> statement-breakpoint
UPDATE `shares` SET `grant_order` = 0;
--> statement-breakpoint
UPDATE `workspace_members` SET `grant_order` = 0;
--> statement-breakpoint
CREATE TRIGGER `shares_grant_order_on_insert`
AFTER INSERT ON `shares`
BEGIN
  UPDATE `grant_clock` SET `value` = `value` + 1 WHERE `id` = 1;
  UPDATE `shares` SET `grant_order` = (SELECT `value` FROM `grant_clock` WHERE `id` = 1)
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
-- A role changed in place is a new grant.
CREATE TRIGGER `shares_grant_order_on_role`
AFTER UPDATE OF `role` ON `shares`
WHEN NEW.`role` IS NOT OLD.`role`
BEGIN
  UPDATE `grant_clock` SET `value` = `value` + 1 WHERE `id` = 1;
  UPDATE `shares` SET `grant_order` = (SELECT `value` FROM `grant_clock` WHERE `id` = 1)
  WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `workspace_members_grant_order_on_insert`
AFTER INSERT ON `workspace_members`
BEGIN
  UPDATE `grant_clock` SET `value` = `value` + 1 WHERE `id` = 1;
  UPDATE `workspace_members` SET `grant_order` = (SELECT `value` FROM `grant_clock` WHERE `id` = 1)
  WHERE `workspace_id` = NEW.`workspace_id` AND `user_id` = NEW.`user_id`;
END;
--> statement-breakpoint
-- A member made admin, or an admin made member, holds a new grant.
CREATE TRIGGER `workspace_members_grant_order_on_role`
AFTER UPDATE OF `role` ON `workspace_members`
WHEN NEW.`role` IS NOT OLD.`role`
BEGIN
  UPDATE `grant_clock` SET `value` = `value` + 1 WHERE `id` = 1;
  UPDATE `workspace_members` SET `grant_order` = (SELECT `value` FROM `grant_clock` WHERE `id` = 1)
  WHERE `workspace_id` = NEW.`workspace_id` AND `user_id` = NEW.`user_id`;
END;
