CREATE TABLE `error_log` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`business_id` varchar(36),
	`post_id` varchar(36),
	`error_type` varchar(100) NOT NULL,
	`error_message` text NOT NULL,
	`layer` varchar(50) NOT NULL,
	`reviewed` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `error_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `error_log` ADD CONSTRAINT `error_log_user_id_iaudit_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `iaudit_users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `error_log` ADD CONSTRAINT `error_log_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `error_log` ADD CONSTRAINT `error_log_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `error_log_user_id_idx` ON `error_log` (`user_id`);--> statement-breakpoint
CREATE INDEX `error_log_reviewed_idx` ON `error_log` (`reviewed`);--> statement-breakpoint
CREATE INDEX `error_log_created_at_idx` ON `error_log` (`created_at`);