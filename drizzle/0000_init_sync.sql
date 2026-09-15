CREATE TABLE `sync_categories` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_categories_cursor_idx` ON `sync_categories` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `sync_chapters` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`manga_id` text NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`chapter_number` real DEFAULT -1 NOT NULL,
	`date_upload` integer,
	`read` integer DEFAULT false NOT NULL,
	`last_page_read` integer DEFAULT 0 NOT NULL,
	`bookmarked` integer DEFAULT false NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_chapters_cursor_idx` ON `sync_chapters` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `sync_cursor` (
	`user_id` text PRIMARY KEY NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_history` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`manga_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_history_cursor_idx` ON `sync_history` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `sync_manga` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`source_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`artist` text,
	`description` text,
	`genres` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`thumbnail_url` text,
	`content_kind` text DEFAULT 'comic' NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`date_added` integer,
	`last_read` integer,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_manga_cursor_idx` ON `sync_manga` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `sync_manga_category` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`manga_id` text NOT NULL,
	`category_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_manga_category_cursor_idx` ON `sync_manga_category` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `sync_settings` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `sync_settings_cursor_idx` ON `sync_settings` (`user_id`,`seq`);