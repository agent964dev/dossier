-- Each person keeps their newest 300 notifications, as every change that
-- writes one keeps them (NOTIFICATIONS_KEPT); the backfill in 0027 did not.
DELETE FROM `notifications` WHERE `id` IN (
	SELECT `id` FROM (
		SELECT `id`, row_number() OVER (
			PARTITION BY `email` ORDER BY `created_at` DESC, `id` DESC) AS `n`
		FROM `notifications`
	) WHERE `n` > 300
);
