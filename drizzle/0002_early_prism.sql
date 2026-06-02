CREATE TABLE `email_verification_tokens` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`token` varchar(64) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `email_verification_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `email_verification_tokens_token_unique` UNIQUE(`token`),
	CONSTRAINT `evt_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`token` varchar(64) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`used` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `password_reset_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `password_reset_tokens_token_unique` UNIQUE(`token`),
	CONSTRAINT `prt_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `refresh_tokens` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`revoked_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`replaced_by_token_hash` varchar(64),
	CONSTRAINT `refresh_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `refresh_tokens_token_hash_unique` UNIQUE(`token_hash`),
	CONSTRAINT `rt_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
ALTER TABLE `iaudit_users` MODIFY COLUMN `email` varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` MODIFY COLUMN `focus_keyword` varchar(255);--> statement-breakpoint
ALTER TABLE `email_verification_tokens` ADD CONSTRAINT `email_verification_tokens_user_id_iaudit_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `iaudit_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_user_id_iaudit_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `iaudit_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_user_id_iaudit_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `iaudit_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `evt_user_id_idx` ON `email_verification_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `prt_user_id_idx` ON `password_reset_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `rt_user_id_idx` ON `refresh_tokens` (`user_id`);--> statement-breakpoint
ALTER TABLE `businesses` ADD CONSTRAINT `businesses_user_id_iaudit_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `iaudit_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cms_connections` ADD CONSTRAINT `cms_connections_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_transactions` ADD CONSTRAINT `credit_transactions_user_id_iaudit_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `iaudit_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_transactions` ADD CONSTRAINT `credit_transactions_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `posts` ADD CONSTRAINT `posts_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE no action ON UPDATE no action;