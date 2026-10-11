-- A session rests on the Google account that opened it: it can be written only
-- while that account belongs to its person, and it ends when the account goes.
-- A takeover's batch and a late sign-in of the account it detaches can then
-- never leave a session behind, whichever reads it.
CREATE TRIGGER `session_requires_attached_account`
BEFORE INSERT ON `session`
WHEN NEW.`google_account_id` IS NULL OR NOT EXISTS (
  SELECT 1 FROM `account`
  WHERE `account`.`id` = NEW.`google_account_id` AND `account`.`user_id` = NEW.`user_id`
)
BEGIN
  SELECT RAISE(ABORT, 'session_account_detached');
END;
--> statement-breakpoint
CREATE TRIGGER `account_removal_ends_sessions`
AFTER DELETE ON `account`
BEGIN
  DELETE FROM `session` WHERE `google_account_id` = OLD.`id`;
END;
