CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `uploads_expiration` ON `uploads` (`expires`);--> statement-breakpoint
ALTER TABLE `posts` ADD `write_token` text;