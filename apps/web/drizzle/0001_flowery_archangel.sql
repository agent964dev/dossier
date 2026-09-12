CREATE TABLE `publication_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "publication_guards_ok_check" CHECK("publication_guards"."ok" = 1)
);
