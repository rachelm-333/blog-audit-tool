ALTER TABLE `posts` ADD `audit_status` enum('pending','running','complete','failed');--> statement-breakpoint
ALTER TABLE `posts` ADD `audited_at` timestamp;