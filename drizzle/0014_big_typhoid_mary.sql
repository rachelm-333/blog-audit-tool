CREATE TABLE `audit_jobs` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`status` enum('running','complete','failed') NOT NULL DEFAULT 'running',
	`total` int NOT NULL DEFAULT 0,
	`completed` int NOT NULL DEFAULT 0,
	`failed` int NOT NULL DEFAULT 0,
	`failed_posts` json,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`finished_at` timestamp,
	CONSTRAINT `audit_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `audit_jobs` ADD CONSTRAINT `audit_jobs_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_jobs_business_id_idx` ON `audit_jobs` (`business_id`);--> statement-breakpoint
CREATE INDEX `audit_jobs_status_idx` ON `audit_jobs` (`status`);