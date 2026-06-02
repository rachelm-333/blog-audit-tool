CREATE TABLE `businesses` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`business_name` text NOT NULL,
	`website_url` text NOT NULL,
	`industry` text NOT NULL,
	`location` text NOT NULL,
	`years_in_business` int,
	`clients_served` int,
	`awards_credentials` text,
	`brand_voice` text NOT NULL,
	`tone` text NOT NULL,
	`target_audience` text NOT NULL,
	`language_style` text,
	`uvp` text NOT NULL,
	`services` json NOT NULL,
	`primary_cta_url` text NOT NULL,
	`primary_cta_label` text NOT NULL,
	`secondary_ctas` json,
	`competitors` json,
	`scrape_status` enum('pending','complete','failed') NOT NULL DEFAULT 'pending',
	`stage1_complete` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `businesses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cms_connections` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`platform` enum('wordpress','wix','shopify','zapier') NOT NULL,
	`site_url` text NOT NULL,
	`credentials_encrypted` json NOT NULL,
	`connection_status` enum('connected','disconnected','error') NOT NULL DEFAULT 'disconnected',
	`last_sync_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cms_connections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `credit_transactions` (
	`id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`type` enum('purchase','use','admin_grant','refund') NOT NULL,
	`credits_delta` int NOT NULL,
	`post_id` varchar(36),
	`stripe_payment_intent_id` text,
	`note` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `credit_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `iaudit_users` (
	`id` varchar(36) NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text NOT NULL,
	`account_type` enum('solo','agency','admin') NOT NULL DEFAULT 'solo',
	`email_verified` boolean NOT NULL DEFAULT false,
	`credits_remaining` int NOT NULL DEFAULT 0,
	`credits_total_purchased` int NOT NULL DEFAULT 0,
	`is_suspended` boolean NOT NULL DEFAULT false,
	`stripe_customer_id` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `iaudit_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `iaudit_users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `oauth_users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`name` text,
	`email` varchar(320),
	`loginMethod` varchar(64),
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `oauth_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `oauth_users_openId_unique` UNIQUE(`openId`)
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`cms_post_id` text NOT NULL,
	`cms_platform` enum('wordpress','wix','shopify','zapier') NOT NULL,
	`title` text NOT NULL,
	`body_original` text NOT NULL,
	`body_rewritten` text,
	`body_approved` text,
	`url` text NOT NULL,
	`status` enum('published','scheduled','draft') NOT NULL,
	`publish_date` timestamp,
	`scheduled_date` timestamp,
	`author_id_cms` text NOT NULL,
	`author_name_cms` text NOT NULL,
	`focus_keyword` text,
	`keyword_source` enum('cms_scraped','ai_suggested','user_entered'),
	`meta_title_original` text,
	`meta_description_original` text,
	`meta_title_rewritten` text,
	`meta_description_rewritten` text,
	`audit_score` int,
	`audit_grade` enum('optimised','strong','needs_work','poor','critical'),
	`audit_results` json,
	`rewrite_score` int,
	`rewrite_grade` enum('optimised','strong','needs_work','poor','critical'),
	`post_back_status` enum('pending','complete','failed'),
	`post_back_at` timestamp,
	`cannibalization_flag` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `posts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
CREATE INDEX `businesses_user_id_idx` ON `businesses` (`user_id`);--> statement-breakpoint
CREATE INDEX `cms_connections_business_id_idx` ON `cms_connections` (`business_id`);--> statement-breakpoint
CREATE INDEX `credit_transactions_user_id_idx` ON `credit_transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `posts_business_id_idx` ON `posts` (`business_id`);--> statement-breakpoint
CREATE INDEX `posts_focus_keyword_idx` ON `posts` (`focus_keyword`);