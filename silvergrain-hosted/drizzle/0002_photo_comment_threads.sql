ALTER TABLE `comments` ADD `photo_id` text;--> statement-breakpoint
CREATE INDEX `comments_photo` ON `comments` (`post_id`,`photo_id`,`status`,`id`);