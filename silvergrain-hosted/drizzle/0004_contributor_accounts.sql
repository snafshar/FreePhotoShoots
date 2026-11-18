CREATE TABLE `account_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`member_id` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `contributors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_events_member` ON `account_events` (`member_id`,`id`);--> statement-breakpoint
CREATE TABLE `approval_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`recipient` text NOT NULL,
	`body` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`sender` text,
	`claim` text,
	`first_attempt` integer,
	`attempted_at` integer,
	`created_at` integer NOT NULL,
	`provider_id` text,
	FOREIGN KEY (`member_id`) REFERENCES `contributors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approval_email_state` ON `approval_emails` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `contributors` (
	`id` text PRIMARY KEY NOT NULL,
	`site_user_id` text NOT NULL,
	`email` text NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`public_email` text DEFAULT '' NOT NULL,
	`public_phone` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contributors_site_user_id_unique` ON `contributors` (`site_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `contributors_handle_unique` ON `contributors` (`handle`);--> statement-breakpoint
CREATE INDEX `contributors_status` ON `contributors` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `owner_id` text REFERENCES contributors(id);--> statement-breakpoint
CREATE INDEX `messages_owner` ON `messages` (`owner_id`,`id`);--> statement-breakpoint
ALTER TABLE `posts` ADD `owner_id` text REFERENCES contributors(id);--> statement-breakpoint
CREATE INDEX `posts_owner` ON `posts` (`owner_id`,`published_at`,`id`);--> statement-breakpoint
ALTER TABLE `uploads` ADD `uploader_id` text;--> statement-breakpoint
CREATE INDEX `uploads_uploader` ON `uploads` (`uploader_id`,`expires`);