CREATE TABLE `free_rewrites` (
	`id` varchar(36) NOT NULL,
	`email` varchar(255) NOT NULL,
	`post_url` text NOT NULL,
	`audit_score_before` int NOT NULL,
	`rewrite_score_after` int NOT NULL,
	`body_rewritten` text NOT NULL,
	`meta_title_rewritten` text NOT NULL,
	`meta_description_rewritten` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `free_rewrites_id` PRIMARY KEY(`id`),
	CONSTRAINT `free_rewrites_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE INDEX `free_rewrites_email_idx` ON `free_rewrites` (`email`);