CREATE TABLE `sync_facts` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`gen` integer DEFAULT 0 NOT NULL,
	`val` integer DEFAULT 0 NOT NULL,
	`state` integer DEFAULT 1 NOT NULL,
	`payload` text,
	`seq` integer NOT NULL,
	PRIMARY KEY(`user_id`, `kind`, `key`)
);
--> statement-breakpoint
CREATE INDEX `sync_facts_cursor_idx` ON `sync_facts` (`user_id`,`seq`);