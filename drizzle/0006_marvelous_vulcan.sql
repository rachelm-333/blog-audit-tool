ALTER TABLE `posts` ADD `paa_question` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `article_type` enum('cornerstone','pillar','cluster');--> statement-breakpoint
ALTER TABLE `posts` ADD `schema_json` json;--> statement-breakpoint
ALTER TABLE `posts` ADD `rewrite_status` enum('pending','running','complete','failed','needs_manual_review');--> statement-breakpoint
ALTER TABLE `posts` ADD `rewritten_at` timestamp;