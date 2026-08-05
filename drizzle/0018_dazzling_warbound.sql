CREATE TABLE `import_jobs` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`connection_id` varchar(36) NOT NULL,
	`status` enum('running','complete','failed') NOT NULL DEFAULT 'running',
	`total` int NOT NULL DEFAULT 0,
	`imported` int NOT NULL DEFAULT 0,
	`keywords_auto_detected` int NOT NULL DEFAULT 0,
	`errors` json,
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`finished_at` timestamp,
	CONSTRAINT `import_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `import_jobs` ADD CONSTRAINT `import_jobs_business_id_businesses_id_fk` FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `import_jobs_business_id_idx` ON `import_jobs` (`business_id`);--> statement-breakpoint
CREATE INDEX `import_jobs_status_idx` ON `import_jobs` (`status`);