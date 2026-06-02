ALTER TABLE `posts` ADD `featured_image_url` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `featured_image_alt` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `body_image_alts` json;--> statement-breakpoint
ALTER TABLE `posts` ADD `categories` json;--> statement-breakpoint
ALTER TABLE `posts` ADD `tags` json;