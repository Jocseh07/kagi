CREATE TABLE `sync_entitlements` (
	`user_id` text PRIMARY KEY NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`polar_customer_id` text,
	`updated_at` integer NOT NULL
);
