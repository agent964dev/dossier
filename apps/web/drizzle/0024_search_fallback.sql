ALTER TABLE `search_docs` ADD `fallback_node_id` text;--> statement-breakpoint
ALTER TABLE `search_docs` ADD `fallback_version_id` text;--> statement-breakpoint
ALTER TABLE `search_docs` ADD `search_fallback` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- By hand: the full-text index gains the fallback companion's column. A
-- virtual table cannot be altered, so it is made again with its triggers and
-- rebuilt from search_docs.
DROP TRIGGER `search_docs_ai`;
--> statement-breakpoint
DROP TRIGGER `search_docs_ad`;
--> statement-breakpoint
DROP TRIGGER `search_docs_au`;
--> statement-breakpoint
DROP TABLE `search_pages`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_pages` USING fts5(
  search_title, search_path, search_body, search_companion, search_fallback,
  content = 'search_docs', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `search_docs_ai` AFTER INSERT ON `search_docs` BEGIN
  INSERT INTO search_pages (rowid, search_title, search_path, search_body, search_companion, search_fallback)
  VALUES (new.id, new.search_title, new.search_path, new.search_body, new.search_companion, new.search_fallback);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_ad` AFTER DELETE ON `search_docs` BEGIN
  INSERT INTO search_pages (search_pages, rowid, search_title, search_path, search_body, search_companion, search_fallback)
  VALUES ('delete', old.id, old.search_title, old.search_path, old.search_body, old.search_companion, old.search_fallback);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_au` AFTER UPDATE ON `search_docs` BEGIN
  INSERT INTO search_pages (search_pages, rowid, search_title, search_path, search_body, search_companion, search_fallback)
  VALUES ('delete', old.id, old.search_title, old.search_path, old.search_body, old.search_companion, old.search_fallback);
  INSERT INTO search_pages (rowid, search_title, search_path, search_body, search_companion, search_fallback)
  VALUES (new.id, new.search_title, new.search_path, new.search_body, new.search_companion, new.search_fallback);
END;
--> statement-breakpoint
INSERT INTO search_pages (search_pages) VALUES ('rebuild');
