ALTER TABLE `posts` MODIFY COLUMN `keyword_source` enum('cms_scraped','user_entered');--> statement-breakpoint
ALTER TABLE `posts` ADD `secondary_keywords` json;--> statement-breakpoint
ALTER TABLE `posts` ADD `rewrite_mode` enum('full_rewrite','smart_patch');