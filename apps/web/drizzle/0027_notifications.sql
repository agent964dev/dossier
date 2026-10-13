CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`type` text NOT NULL,
	`tree_id` text NOT NULL,
	`page_node_id` text NOT NULL,
	`comment_node_id` text NOT NULL,
	`anchor` text,
	`label` text,
	`via` text,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`page_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_type_check" CHECK("notifications"."type" in ('mention', 'reply'))
);
--> statement-breakpoint
CREATE INDEX `notifications_email_idx` ON `notifications` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`email`,`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_page_idx` ON `notifications` (`page_node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_comment_email_unique` ON `notifications` (`comment_node_id`,`email`);--> statement-breakpoint
-- Mentions written before notifications become their people's
-- notifications, the newest per person and comment, read if they opened the
-- page since, so "mentioned you" shows as it did. Mentions on comments
-- deleted since come along too, and a person may get more than the 300
-- a change keeps until their next notification is written; every read
-- leaves out deleted comments and checks the page's access.
INSERT OR IGNORE INTO `notifications` (`id`, `email`, `type`, `tree_id`, `page_node_id`, `comment_node_id`, `anchor`, `label`, `via`, `actor_id`, `created_at`, `read_at`)
SELECT lower(hex(randomblob(16))), m.email, 'mention', m.tree_id, m.page_node_id, m.comment_node_id,
	json_extract(v.json_value, '$.anchor'), json_extract(v.json_value, '$.label'), m.via, e.actor_id, m.created_at,
	(SELECT s.last_seen_at FROM seen_by s JOIN `user` u ON u.id = s.user_id
		WHERE s.node_id = m.page_node_id AND lower(u.email) = m.email AND s.last_seen_at >= m.created_at LIMIT 1)
FROM mentions m
	JOIN events e ON e.tree_id = m.tree_id AND e.seq = m.event_seq AND e.actor_id IS NOT NULL
	JOIN nodes c ON c.id = m.comment_node_id
	LEFT JOIN node_versions v ON v.id = c.current_version_id
ORDER BY m.created_at DESC;