import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ---------------------------------------------------------------------------
// Design notes:
//  - MySQL requires a key length for TEXT columns used in UNIQUE/INDEX constraints.
//    email and focus_keyword use varchar so they can be indexed directly.
//  - All iAudit application tables use UUID (varchar(36)) primary keys.
//  - The oauth_users table is the Manus OAuth session table (do not remove).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// oauth_users — Manus OAuth session table (scaffold core — do not remove)
// Used by the Manus OAuth plumbing in server/_core/sdk.ts and server/_core/oauth.ts
// ---------------------------------------------------------------------------
export const oauthUsers = mysqlTable("oauth_users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type OAuthUser = typeof oauthUsers.$inferSelect;
export type InsertOAuthUser = typeof oauthUsers.$inferInsert;

// Keep legacy alias so server/db.ts and sdk.ts continue to compile without changes
export const users = oauthUsers;
export type User = OAuthUser;
export type InsertUser = InsertOAuthUser;

// ---------------------------------------------------------------------------
// iaudit_users — iAudit application users (Section 14.1)
// Email + password auth as specified in the scope. Completely separate from
// the Manus OAuth table above.
// ---------------------------------------------------------------------------
export const iauditUsers = mysqlTable(
  "iaudit_users",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // UUID stored as varchar(36)
    // varchar(255): MySQL requires fixed-length column for UNIQUE index (RFC 5321 max email = 254 chars)
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    accountType: mysqlEnum("account_type", ["solo", "agency", "admin"])
      .notNull()
      .default("solo"),
    emailVerified: boolean("email_verified").notNull().default(false),
    creditsRemaining: int("credits_remaining").notNull().default(0),
    creditsTotalPurchased: int("credits_total_purchased").notNull().default(0),
    isSuspended: boolean("is_suspended").notNull().default(false),
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("iaudit_users_email_unique").on(table.email),
  ]
);

export type IauditUser = typeof iauditUsers.$inferSelect;
export type InsertIauditUser = typeof iauditUsers.$inferInsert;

// ---------------------------------------------------------------------------
// businesses — Business profiles (Section 14.2)
// ---------------------------------------------------------------------------
export const businesses = mysqlTable(
  "businesses",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // UUID
    // FK → iaudit_users.id (enforced by fk_businesses_user_id constraint in DB)
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => iauditUsers.id),
    businessName: text("business_name").notNull(),
    websiteUrl: text("website_url").notNull(),
    industry: text("industry").notNull(),
    location: text("location").notNull(),
    yearsInBusiness: int("years_in_business"),
    clientsServed: int("clients_served"),
    awardsCredentials: text("awards_credentials"),
    brandVoice: text("brand_voice").notNull(),
    tone: text("tone").notNull(),
    targetAudience: text("target_audience").notNull(),
    languageStyle: text("language_style"),
    uvp: text("uvp").notNull(),
    // JSONB: Array of {name, description}
    services: json("services").notNull(),
    primaryCtaUrl: text("primary_cta_url").notNull(),
    primaryCtaLabel: text("primary_cta_label").notNull(),
    // JSONB: Array of {url, label} — max 3
    secondaryCtas: json("secondary_ctas"),
    // JSONB: Array of competitor {url} — max 3
    competitors: json("competitors"),
    scrapeStatus: mysqlEnum("scrape_status", ["pending", "complete", "failed"])
      .notNull()
      .default("pending"),
    // Scrape failure reason — persisted so UI can show the correct failure banner
    scrapeFailureType: varchar("scrape_failure_type", { length: 64 }),
    stage1Complete: boolean("stage1_complete").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("businesses_user_id_idx").on(table.userId),
  ]
);

export type Business = typeof businesses.$inferSelect;
export type InsertBusiness = typeof businesses.$inferInsert;

// ---------------------------------------------------------------------------
// cms_connections — CMS platform connections (Section 14.3)
// SECURITY: credentials_encrypted MUST always store encrypted data — never plain text.
// ---------------------------------------------------------------------------
export const cmsConnections = mysqlTable(
  "cms_connections",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // UUID
    // FK → businesses.id (enforced by fk_cms_connections_business_id constraint in DB)
    businessId: varchar("business_id", { length: 36 })
      .notNull()
      .references(() => businesses.id),
    platform: mysqlEnum("platform", ["wordpress", "wix", "shopify", "zapier"])
      .notNull(),
    siteUrl: text("site_url").notNull(),
    // JSONB: Encrypted credentials — NEVER store plain text API keys or passwords here.
    // Always encrypt before writing; decrypt after reading. See Layer 2 auth service.
    credentialsEncrypted: json("credentials_encrypted").notNull(),
    connectionStatus: mysqlEnum("connection_status", [
      "connected",
      "disconnected",
      "error",
    ])
      .notNull()
      .default("disconnected"),
    lastSyncAt: timestamp("last_sync_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("cms_connections_business_id_idx").on(table.businessId),
  ]
);

export type CmsConnection = typeof cmsConnections.$inferSelect;
export type InsertCmsConnection = typeof cmsConnections.$inferInsert;

// ---------------------------------------------------------------------------
// posts — Imported and rewritten blog posts (Section 14.4)
// ---------------------------------------------------------------------------
export const posts = mysqlTable(
  "posts",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // UUID (iAudit internal)
    // FK → businesses.id (enforced by fk_posts_business_id constraint in DB)
    businessId: varchar("business_id", { length: 36 })
      .notNull()
      .references(() => businesses.id),
    cmsPostId: text("cms_post_id").notNull(), // Original ID in the CMS — used for post-back
    cmsPlatform: mysqlEnum("cms_platform", [
      "wordpress",
      "wix",
      "shopify",
      "zapier",
    ]).notNull(),
    title: text("title").notNull(),
    // Original content as imported — NEVER overwritten after initial import
    bodyOriginal: text("body_original").notNull(),
    // AI-generated rewrite — set after rewrite job completes
    bodyRewritten: text("body_rewritten"),
    // Final approved version — this is what gets posted back to CMS
    bodyApproved: text("body_approved"),
    url: text("url").notNull(), // Full permalink — preserved, never changed
    status: mysqlEnum("status", ["published", "scheduled", "draft"]).notNull(),
    publishDate: timestamp("publish_date"), // Preserved from CMS
    scheduledDate: timestamp("scheduled_date"), // Preserved from CMS
    authorIdCms: text("author_id_cms").notNull(), // Author ID in CMS — used on post-back
    authorNameCms: text("author_name_cms").notNull(), // Author display name — UI only
    // varchar(255): MySQL requires fixed-length column for index
    focusKeyword: varchar("focus_keyword", { length: 255 }), // Null until confirmed by user
    keywordSource: mysqlEnum("keyword_source", [
      "cms_scraped",
      "ai_suggested",
      "user_entered",
    ]),
    metaTitleOriginal: text("meta_title_original"),
    metaDescriptionOriginal: text("meta_description_original"),
    metaTitleRewritten: text("meta_title_rewritten"),
    metaDescriptionRewritten: text("meta_description_rewritten"),
    auditScore: int("audit_score"), // 0–16 points, null until audited
    auditGrade: mysqlEnum("audit_grade", [
      "optimised",
      "strong",
      "needs_work",
      "poor",
      "critical",
    ]),
    // JSONB: Full per-point pass/fail results with notes
    auditResults: json("audit_results"),
    rewriteScore: int("rewrite_score"), // Score after rewrite
    rewriteGrade: mysqlEnum("rewrite_grade", [
      "optimised",
      "strong",
      "needs_work",
      "poor",
      "critical",
    ]),
    postBackStatus: mysqlEnum("post_back_status", [
      "pending",
      "complete",
      "failed",
    ]),
    postBackAt: timestamp("post_back_at"),
    cannibalizationFlag: boolean("cannibalization_flag").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("posts_business_id_idx").on(table.businessId),
    index("posts_focus_keyword_idx").on(table.focusKeyword),
  ]
);

export type Post = typeof posts.$inferSelect;
export type InsertPost = typeof posts.$inferInsert;

// ---------------------------------------------------------------------------
// credit_transactions — Credit purchase and usage ledger (Section 14.5)
// ---------------------------------------------------------------------------
export const creditTransactions = mysqlTable(
  "credit_transactions",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // UUID
    // FK → iaudit_users.id (enforced by fk_credit_transactions_user_id constraint in DB)
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => iauditUsers.id),
    type: mysqlEnum("type", ["purchase", "use", "admin_grant", "refund"])
      .notNull(),
    // Positive = credits added (purchase/grant/refund). Negative = credits consumed (use).
    creditsDelta: int("credits_delta").notNull(),
    // Set when type = 'use' — links to the post that consumed the credit
    // FK → posts.id (enforced by fk_credit_transactions_post_id constraint in DB)
    postId: varchar("post_id", { length: 36 }).references(() => posts.id),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    note: text("note"), // Admin note for manual grants
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("credit_transactions_user_id_idx").on(table.userId),
  ]
);

export type CreditTransaction = typeof creditTransactions.$inferSelect;
export type InsertCreditTransaction = typeof creditTransactions.$inferInsert;

// ---------------------------------------------------------------------------
// email_verification_tokens — One-time tokens sent via Resend on registration
// ---------------------------------------------------------------------------
export const emailVerificationTokens = mysqlTable(
  "email_verification_tokens",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // UUID
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => iauditUsers.id),
    token: varchar("token", { length: 64 }).notNull().unique(), // Secure random hex token
    expiresAt: timestamp("expires_at").notNull(), // 24-hour expiry
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("evt_user_id_idx").on(table.userId),
    uniqueIndex("evt_token_unique").on(table.token),
  ]
);

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type InsertEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;

// ---------------------------------------------------------------------------
// password_reset_tokens — One-time tokens sent via Resend for password reset
// ---------------------------------------------------------------------------
export const passwordResetTokens = mysqlTable(
  "password_reset_tokens",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // UUID
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => iauditUsers.id),
    token: varchar("token", { length: 64 }).notNull().unique(), // Secure random hex token
    expiresAt: timestamp("expires_at").notNull(), // 1-hour expiry (scope requirement)
    used: boolean("used").notNull().default(false), // Marked true after single use
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("prt_user_id_idx").on(table.userId),
    uniqueIndex("prt_token_unique").on(table.token),
  ]
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type InsertPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// ---------------------------------------------------------------------------
// refresh_tokens — Rotating refresh tokens (30-day expiry, one per session)
// Invalidated on logout, password change, or account suspension.
// ---------------------------------------------------------------------------
export const refreshTokens = mysqlTable(
  "refresh_tokens",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // UUID
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => iauditUsers.id),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(), // SHA-256 hash of the raw token
    expiresAt: timestamp("expires_at").notNull(), // 30-day expiry
    revokedAt: timestamp("revoked_at"), // Set on logout / password change / suspension
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Rotation chain: tracks which token this replaced (for replay-attack detection)
    replacedByTokenHash: varchar("replaced_by_token_hash", { length: 64 }),
  },
  (table) => [
    index("rt_user_id_idx").on(table.userId),
    uniqueIndex("rt_token_hash_unique").on(table.tokenHash),
  ]
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type InsertRefreshToken = typeof refreshTokens.$inferInsert;
