/**
 * apply-remaining-migration.mjs
 * Applies the remaining DDL statements from migration 0001 that haven't been
 * executed yet (iaudit_users, oauth_users, posts tables + remaining indexes),
 * then records the migration as complete in __drizzle_migrations.
 *
 * Run with: node scripts/apply-remaining-migration.mjs
 */

import mysql from "mysql2/promise";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load DATABASE_URL from environment (injected by Manus platform)
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const connection = await mysql.createConnection(DATABASE_URL);

// Statements that still need to be applied
const statements = [
  // iaudit_users — iAudit application users (Section 14.1)
  `CREATE TABLE IF NOT EXISTS \`iaudit_users\` (
    \`id\` varchar(36) NOT NULL,
    \`email\` varchar(255) NOT NULL,
    \`password_hash\` text NOT NULL,
    \`name\` text NOT NULL,
    \`account_type\` enum('solo','agency','admin') NOT NULL DEFAULT 'solo',
    \`email_verified\` boolean NOT NULL DEFAULT false,
    \`credits_remaining\` int NOT NULL DEFAULT 0,
    \`credits_total_purchased\` int NOT NULL DEFAULT 0,
    \`is_suspended\` boolean NOT NULL DEFAULT false,
    \`stripe_customer_id\` text,
    \`created_at\` timestamp NOT NULL DEFAULT (now()),
    \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`iaudit_users_id\` PRIMARY KEY(\`id\`),
    CONSTRAINT \`iaudit_users_email_unique\` UNIQUE(\`email\`)
  )`,

  // oauth_users — Manus OAuth session table (renamed from users)
  `CREATE TABLE IF NOT EXISTS \`oauth_users\` (
    \`id\` int AUTO_INCREMENT NOT NULL,
    \`openId\` varchar(64) NOT NULL,
    \`name\` text,
    \`email\` varchar(320),
    \`loginMethod\` varchar(64),
    \`role\` enum('user','admin') NOT NULL DEFAULT 'user',
    \`createdAt\` timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    \`lastSignedIn\` timestamp NOT NULL DEFAULT (now()),
    CONSTRAINT \`oauth_users_id\` PRIMARY KEY(\`id\`),
    CONSTRAINT \`oauth_users_openId_unique\` UNIQUE(\`openId\`)
  )`,

  // posts — Imported and rewritten blog posts (Section 14.4)
  `CREATE TABLE IF NOT EXISTS \`posts\` (
    \`id\` varchar(36) NOT NULL,
    \`business_id\` varchar(36) NOT NULL,
    \`cms_post_id\` text NOT NULL,
    \`cms_platform\` enum('wordpress','wix','shopify','zapier') NOT NULL,
    \`title\` text NOT NULL,
    \`body_original\` text NOT NULL,
    \`body_rewritten\` text,
    \`body_approved\` text,
    \`url\` text NOT NULL,
    \`status\` enum('published','scheduled','draft') NOT NULL,
    \`publish_date\` timestamp NULL,
    \`scheduled_date\` timestamp NULL,
    \`author_id_cms\` text NOT NULL,
    \`author_name_cms\` text NOT NULL,
    \`focus_keyword\` text,
    \`keyword_source\` enum('cms_scraped','ai_suggested','user_entered'),
    \`meta_title_original\` text,
    \`meta_description_original\` text,
    \`meta_title_rewritten\` text,
    \`meta_description_rewritten\` text,
    \`audit_score\` int,
    \`audit_grade\` enum('optimised','strong','needs_work','poor','critical'),
    \`audit_results\` json,
    \`rewrite_score\` int,
    \`rewrite_grade\` enum('optimised','strong','needs_work','poor','critical'),
    \`post_back_status\` enum('pending','complete','failed'),
    \`post_back_at\` timestamp NULL,
    \`cannibalization_flag\` boolean NOT NULL DEFAULT false,
    \`created_at\` timestamp NOT NULL DEFAULT (now()),
    \`updated_at\` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`posts_id\` PRIMARY KEY(\`id\`)
  )`,

  // Indexes — use IF NOT EXISTS equivalent (CREATE INDEX fails if exists, so check first)
  `CREATE INDEX IF NOT EXISTS \`businesses_user_id_idx\` ON \`businesses\` (\`user_id\`)`,
  `CREATE INDEX IF NOT EXISTS \`cms_connections_business_id_idx\` ON \`cms_connections\` (\`business_id\`)`,
  `CREATE INDEX IF NOT EXISTS \`credit_transactions_user_id_idx\` ON \`credit_transactions\` (\`user_id\`)`,
  `CREATE INDEX IF NOT EXISTS \`posts_business_id_idx\` ON \`posts\` (\`business_id\`)`,
  `CREATE INDEX IF NOT EXISTS \`posts_focus_keyword_idx\` ON \`posts\` (\`focus_keyword\`)`,
];

// MySQL doesn't support CREATE INDEX IF NOT EXISTS — use a workaround
const indexStatements = [
  {
    name: "businesses_user_id_idx",
    table: "businesses",
    sql: "CREATE INDEX `businesses_user_id_idx` ON `businesses` (`user_id`)",
  },
  {
    name: "cms_connections_business_id_idx",
    table: "cms_connections",
    sql: "CREATE INDEX `cms_connections_business_id_idx` ON `cms_connections` (`business_id`)",
  },
  {
    name: "credit_transactions_user_id_idx",
    table: "credit_transactions",
    sql: "CREATE INDEX `credit_transactions_user_id_idx` ON `credit_transactions` (`user_id`)",
  },
  {
    name: "posts_business_id_idx",
    table: "posts",
    sql: "CREATE INDEX `posts_business_id_idx` ON `posts` (`business_id`)",
  },
  {
    name: "posts_focus_keyword_idx",
    table: "posts",
    // MySQL requires prefix length for TEXT columns in indexes
    sql: "CREATE INDEX `posts_focus_keyword_idx` ON `posts` (`focus_keyword`(100))",
  },
];

const tableStatements = statements.slice(0, 3);

console.log("=== Applying remaining migration statements ===\n");

// Apply table creation statements
for (const sql of tableStatements) {
  const tableName = sql.match(/CREATE TABLE IF NOT EXISTS `(\w+)`/)?.[1] ?? "unknown";
  try {
    await connection.execute(sql);
    console.log(`✓ Table created: ${tableName}`);
  } catch (err) {
    if (err.code === "ER_TABLE_EXISTS_ERROR") {
      console.log(`  Table already exists (skipped): ${tableName}`);
    } else {
      console.error(`✗ Failed to create table ${tableName}:`, err.message);
      await connection.end();
      process.exit(1);
    }
  }
}

// Apply index creation statements (check if index exists first)
for (const { name, table, sql } of indexStatements) {
  try {
    const [rows] = await connection.execute(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [table, name]
    );
    if (rows.length > 0) {
      console.log(`  Index already exists (skipped): ${name}`);
    } else {
      await connection.execute(sql);
      console.log(`✓ Index created: ${name}`);
    }
  } catch (err) {
    console.error(`✗ Failed to create index ${name}:`, err.message);
    await connection.end();
    process.exit(1);
  }
}

// Record the migration as applied in __drizzle_migrations
const migrationHash = "068ff065-57e2-4f9b-85cf-9fd52491a831";
try {
  const [existing] = await connection.execute(
    "SELECT id FROM __drizzle_migrations WHERE hash = ?",
    [migrationHash]
  );
  if (existing.length > 0) {
    console.log(`\n  Migration already recorded in __drizzle_migrations (skipped)`);
  } else {
    await connection.execute(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
      [migrationHash, Date.now()]
    );
    console.log(`\n✓ Migration recorded in __drizzle_migrations: ${migrationHash}`);
  }
} catch (err) {
  console.error("✗ Failed to record migration:", err.message);
  await connection.end();
  process.exit(1);
}

await connection.end();
console.log("\n=== Migration complete ===");
