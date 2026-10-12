CREATE TABLE `search_docs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`tree_id` text NOT NULL,
	`version_id` text NOT NULL,
	`companion_node_id` text,
	`companion_version_id` text,
	`title` text NOT NULL,
	`path` text NOT NULL,
	`search_title` text NOT NULL,
	`search_path` text NOT NULL,
	`search_body` text NOT NULL,
	`search_companion` text NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_docs_node_id_unique` ON `search_docs` (`node_id`);--> statement-breakpoint
CREATE INDEX `search_docs_tree_idx` ON `search_docs` (`tree_id`);--> statement-breakpoint
CREATE INDEX `search_docs_companion_idx` ON `search_docs` (`companion_node_id`);--> statement-breakpoint
CREATE INDEX `nodes_name_nocase_idx` ON `nodes` ("name" collate nocase);--> statement-breakpoint
-- By hand: the full-text index over search_docs, which holds the text
-- (external content). Arabic marks are removed before text reaches it;
-- remove_diacritics 2 folds Latin accents. D1 cannot export a database that
-- holds a virtual table, so backups rely on Time Travel.
CREATE VIRTUAL TABLE `search_pages` USING fts5(
  search_title, search_path, search_body, search_companion,
  content = 'search_docs', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `search_docs_ai` AFTER INSERT ON `search_docs` BEGIN
  INSERT INTO search_pages (rowid, search_title, search_path, search_body, search_companion)
  VALUES (new.id, new.search_title, new.search_path, new.search_body, new.search_companion);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_ad` AFTER DELETE ON `search_docs` BEGIN
  INSERT INTO search_pages (search_pages, rowid, search_title, search_path, search_body, search_companion)
  VALUES ('delete', old.id, old.search_title, old.search_path, old.search_body, old.search_companion);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_au` AFTER UPDATE ON `search_docs` BEGIN
  INSERT INTO search_pages (search_pages, rowid, search_title, search_path, search_body, search_companion)
  VALUES ('delete', old.id, old.search_title, old.search_path, old.search_body, old.search_companion);
  INSERT INTO search_pages (rowid, search_title, search_path, search_body, search_companion)
  VALUES (new.id, new.search_title, new.search_path, new.search_body, new.search_companion);
END;
