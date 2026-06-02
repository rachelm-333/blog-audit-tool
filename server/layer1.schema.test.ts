/**
 * layer1.schema.test.ts
 *
 * Layer 1 verification tests — Database Schema (Section 14 of iAudit Master Scope)
 *
 * Verifies:
 *  1. All 5 tables exist with correct columns and types
 *  2. All required indexes exist
 *  3. Enum constraints enforce only allowed values
 *  4. Test insert and read works on every table
 *  5. Foreign key relationships are structurally correct
 *  6. JSONB (json) columns accept and return structured data
 *  7. Default values are applied correctly
 *  8. Nullable vs NOT NULL constraints are correct
 *
 * These tests connect directly to the live database using DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------
let connection: mysql.Connection;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — cannot run Layer 1 tests");
  connection = await mysql.createConnection(url);
});

afterAll(async () => {
  if (connection) await connection.end();
});

// ---------------------------------------------------------------------------
// Helper: generate a UUID-like test ID
// ---------------------------------------------------------------------------
function testId(): string {
  // Use nanoid to generate a unique 36-char-compatible test ID
  return `test-${nanoid(10)}-${Date.now().toString(36)}`.slice(0, 36);
}

// ---------------------------------------------------------------------------
// Helper: execute a query and return rows
// ---------------------------------------------------------------------------
async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const [rows] = await connection.execute(sql, params);
  return rows as T[];
}

// ---------------------------------------------------------------------------
// Section 1: Table existence
// ---------------------------------------------------------------------------
describe("Layer 1 — Table Existence", () => {
  const requiredTables = [
    "iaudit_users",
    "businesses",
    "cms_connections",
    "posts",
    "credit_transactions",
  ];

  it("all 5 required tables exist in the database", async () => {
    const rows = await query<{ TABLE_NAME: string }>(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${requiredTables.map(() => "?").join(",")})
       ORDER BY TABLE_NAME`,
      requiredTables
    );
    const found = rows.map((r) => r.TABLE_NAME).sort();
    expect(found).toEqual([...requiredTables].sort());
  });
});

// ---------------------------------------------------------------------------
// Section 2: Column structure verification
// ---------------------------------------------------------------------------
describe("Layer 1 — iaudit_users Column Structure", () => {
  it("has all required columns with correct types", async () => {
    const rows = await query<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string; COLUMN_DEFAULT: string | null }>(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'iaudit_users'
       ORDER BY ORDINAL_POSITION`
    );
    const cols = Object.fromEntries(rows.map((r) => [r.COLUMN_NAME, r]));

    expect(cols["id"].DATA_TYPE).toBe("varchar");
    expect(cols["email"].DATA_TYPE).toBe("varchar");
    expect(cols["password_hash"].DATA_TYPE).toBe("text");
    expect(cols["name"].DATA_TYPE).toBe("text");
    expect(cols["account_type"].DATA_TYPE).toBe("enum");
    expect(cols["email_verified"].DATA_TYPE).toBe("tinyint"); // boolean = tinyint in MySQL
    expect(cols["credits_remaining"].DATA_TYPE).toBe("int");
    expect(cols["credits_total_purchased"].DATA_TYPE).toBe("int");
    expect(cols["is_suspended"].DATA_TYPE).toBe("tinyint");
    expect(cols["stripe_customer_id"].DATA_TYPE).toBe("text");
    expect(cols["created_at"].DATA_TYPE).toBe("timestamp");
    expect(cols["updated_at"].DATA_TYPE).toBe("timestamp");
  });

  it("email column has a UNIQUE constraint", async () => {
    const rows = await query<{ INDEX_NAME: string; NON_UNIQUE: number }>(
      `SELECT INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'iaudit_users'
       AND COLUMN_NAME = 'email'`
    );
    expect(rows.length).toBeGreaterThan(0);
    // MySQL may return NON_UNIQUE as string "0" or number 0 — both mean unique
    expect(Number(rows[0].NON_UNIQUE)).toBe(0); // 0 = unique index
  });

  it("numeric columns default to 0", async () => {
    const rows = await query<{ COLUMN_NAME: string; COLUMN_DEFAULT: string }>(
      `SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'iaudit_users'
       AND COLUMN_NAME IN ('credits_remaining','credits_total_purchased')`
    );
    for (const row of rows) {
      expect(row.COLUMN_DEFAULT).toBe("0");
    }
  });

  it("boolean columns default to false (0)", async () => {
    const rows = await query<{ COLUMN_NAME: string; COLUMN_DEFAULT: string }>(
      `SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'iaudit_users'
       AND COLUMN_NAME IN ('email_verified','is_suspended')`
    );
    for (const row of rows) {
      expect(row.COLUMN_DEFAULT).toBe("0");
    }
  });
});

describe("Layer 1 — businesses Column Structure", () => {
  it("has JSONB (json) columns for services, secondary_ctas, competitors", async () => {
    const rows = await query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
       AND COLUMN_NAME IN ('services','secondary_ctas','competitors')`
    );
    for (const row of rows) {
      expect(row.DATA_TYPE).toBe("json");
    }
  });

  it("services column is NOT NULL", async () => {
    const rows = await query<{ IS_NULLABLE: string }>(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
       AND COLUMN_NAME = 'services'`
    );
    expect(rows[0].IS_NULLABLE).toBe("NO");
  });

  it("secondary_ctas and competitors are nullable", async () => {
    const rows = await query<{ COLUMN_NAME: string; IS_NULLABLE: string }>(
      `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses'
       AND COLUMN_NAME IN ('secondary_ctas','competitors')`
    );
    for (const row of rows) {
      expect(row.IS_NULLABLE).toBe("YES");
    }
  });
});

describe("Layer 1 — posts Column Structure", () => {
  it("has audit_results as json column", async () => {
    const rows = await query<{ DATA_TYPE: string }>(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'
       AND COLUMN_NAME = 'audit_results'`
    );
    expect(rows[0].DATA_TYPE).toBe("json");
  });

  it("body_original is NOT NULL, body_rewritten and body_approved are nullable", async () => {
    const rows = await query<{ COLUMN_NAME: string; IS_NULLABLE: string }>(
      `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'
       AND COLUMN_NAME IN ('body_original','body_rewritten','body_approved')`
    );
    const cols = Object.fromEntries(rows.map((r) => [r.COLUMN_NAME, r.IS_NULLABLE]));
    expect(cols["body_original"]).toBe("NO");
    expect(cols["body_rewritten"]).toBe("YES");
    expect(cols["body_approved"]).toBe("YES");
  });

  it("cannibalization_flag defaults to false", async () => {
    const rows = await query<{ COLUMN_DEFAULT: string }>(
      `SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'
       AND COLUMN_NAME = 'cannibalization_flag'`
    );
    expect(rows[0].COLUMN_DEFAULT).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Section 3: Index verification
// ---------------------------------------------------------------------------
describe("Layer 1 — Index Verification", () => {
  const expectedIndexes = [
    { table: "iaudit_users", index: "iaudit_users_email_unique" },
    { table: "businesses", index: "businesses_user_id_idx" },
    { table: "cms_connections", index: "cms_connections_business_id_idx" },
    { table: "posts", index: "posts_business_id_idx" },
    { table: "posts", index: "posts_focus_keyword_idx" },
    { table: "credit_transactions", index: "credit_transactions_user_id_idx" },
  ];

  for (const { table, index } of expectedIndexes) {
    it(`index ${index} exists on ${table}`, async () => {
      const rows = await query<{ INDEX_NAME: string }>(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, index]
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Section 4: Test insert and read on every table
// ---------------------------------------------------------------------------
describe("Layer 1 — Test Insert and Read: iaudit_users", () => {
  const userId = testId();

  it("inserts a user row successfully", async () => {
    await connection.execute(
      `INSERT INTO iaudit_users (id, email, password_hash, name, account_type, email_verified, credits_remaining, credits_total_purchased, is_suspended)
       VALUES (?, ?, ?, ?, 'solo', false, 0, 0, false)`,
      [userId, `test-${userId}@example.com`, "$2b$10$testhash", "Test User Layer1"]
    );
  });

  it("reads the inserted user row back correctly", async () => {
    const rows = await query<{
      id: string;
      email: string;
      name: string;
      account_type: string;
      email_verified: number;
      credits_remaining: number;
      credits_total_purchased: number;
      is_suspended: number;
      stripe_customer_id: string | null;
    }>(
      `SELECT id, email, name, account_type, email_verified, credits_remaining, credits_total_purchased, is_suspended, stripe_customer_id
       FROM iaudit_users WHERE id = ?`,
      [userId]
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.id).toBe(userId);
    expect(row.email).toBe(`test-${userId}@example.com`);
    expect(row.name).toBe("Test User Layer1");
    expect(row.account_type).toBe("solo");
    expect(row.email_verified).toBe(0); // false
    expect(row.credits_remaining).toBe(0);
    expect(row.credits_total_purchased).toBe(0);
    expect(row.is_suspended).toBe(0); // false
    expect(row.stripe_customer_id).toBeNull();
  });

  it("enforces unique email constraint", async () => {
    await expect(
      connection.execute(
        `INSERT INTO iaudit_users (id, email, password_hash, name, account_type)
         VALUES (?, ?, ?, ?, 'solo')`,
        [testId(), `test-${userId}@example.com`, "$2b$10$testhash", "Duplicate Email"]
      )
    ).rejects.toThrow();
  });

  it("enforces account_type enum (rejects invalid value)", async () => {
    await expect(
      connection.execute(
        `INSERT INTO iaudit_users (id, email, password_hash, name, account_type)
         VALUES (?, ?, ?, ?, 'superuser')`,
        [testId(), `invalid-${testId()}@example.com`, "$2b$10$hash", "Bad Type"]
      )
    ).rejects.toThrow();
  });

  // Cleanup
  afterAll(async () => {
    await connection.execute("DELETE FROM iaudit_users WHERE id = ?", [userId]);
  });
});

describe("Layer 1 — Test Insert and Read: businesses", () => {
  const userId = testId();
  const businessId = testId();

  beforeAll(async () => {
    // Create a parent user first
    await connection.execute(
      `INSERT INTO iaudit_users (id, email, password_hash, name, account_type)
       VALUES (?, ?, ?, ?, 'solo')`,
      [userId, `biz-test-${userId}@example.com`, "$2b$10$hash", "Business Test User"]
    );
  });

  it("inserts a business row with JSONB fields successfully", async () => {
    const services = JSON.stringify([
      { name: "Pool Installation", description: "Full pool build" },
    ]);
    const secondaryCtas = JSON.stringify([{ url: "https://example.com/contact", label: "Contact Us" }]);
    const competitors = JSON.stringify([{ url: "https://competitor.com" }]);

    await connection.execute(
      `INSERT INTO businesses (id, user_id, business_name, website_url, industry, location,
        brand_voice, tone, target_audience, uvp, services, primary_cta_url, primary_cta_label,
        secondary_ctas, competitors, scrape_status, stage1_complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', false)`,
      [
        businessId, userId, "Test Pool Co", "https://testpool.com",
        "Pool Installation", "Sydney, NSW",
        "Professional and clear brand voice", "Professional",
        "Sydney homeowners", "Best pools in Sydney",
        services, "https://testpool.com/quote", "Get a Quote",
        secondaryCtas, competitors,
      ]
    );
  });

  it("reads the business row back with JSONB fields parsed correctly", async () => {
    const rows = await query<{
      id: string;
      user_id: string;
      business_name: string;
      services: string;
      secondary_ctas: string;
      competitors: string;
      scrape_status: string;
      stage1_complete: number;
    }>(
      `SELECT id, user_id, business_name, services, secondary_ctas, competitors, scrape_status, stage1_complete
       FROM businesses WHERE id = ?`,
      [businessId]
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.id).toBe(businessId);
    expect(row.user_id).toBe(userId);
    expect(row.business_name).toBe("Test Pool Co");
    expect(row.scrape_status).toBe("pending");
    expect(row.stage1_complete).toBe(0);

    // JSONB fields should parse correctly
    const services = typeof row.services === "string" ? JSON.parse(row.services) : row.services;
    expect(Array.isArray(services)).toBe(true);
    expect(services[0].name).toBe("Pool Installation");

    const secondaryCtas = typeof row.secondary_ctas === "string" ? JSON.parse(row.secondary_ctas) : row.secondary_ctas;
    expect(secondaryCtas[0].label).toBe("Contact Us");
  });

  it("enforces scrape_status enum (rejects invalid value)", async () => {
    await expect(
      connection.execute(
        `INSERT INTO businesses (id, user_id, business_name, website_url, industry, location,
          brand_voice, tone, target_audience, uvp, services, primary_cta_url, primary_cta_label, scrape_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'in_progress')`,
        [testId(), userId, "Bad Status Co", "https://x.com", "Tech", "Sydney",
          "Voice", "Professional", "Audience", "UVP", "https://x.com/cta", "CTA"]
      )
    ).rejects.toThrow();
  });

  afterAll(async () => {
    await connection.execute("DELETE FROM businesses WHERE id = ?", [businessId]);
    await connection.execute("DELETE FROM iaudit_users WHERE id = ?", [userId]);
  });
});

describe("Layer 1 — Test Insert and Read: cms_connections", () => {
  const userId = testId();
  const businessId = testId();
  const connectionId = testId();

  beforeAll(async () => {
    await connection.execute(
      `INSERT INTO iaudit_users (id, email, password_hash, name, account_type)
       VALUES (?, ?, ?, ?, 'agency')`,
      [userId, `cms-test-${userId}@example.com`, "$2b$10$hash", "CMS Test User"]
    );
    await connection.execute(
      `INSERT INTO businesses (id, user_id, business_name, website_url, industry, location,
        brand_voice, tone, target_audience, uvp, services, primary_cta_url, primary_cta_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      [businessId, userId, "CMS Test Biz", "https://cmstest.com", "Tech", "Melbourne, VIC",
        "Voice", "Friendly", "Audience", "UVP", "https://cmstest.com/cta", "Book Now"]
    );
  });

  it("inserts a cms_connection with encrypted credentials JSONB", async () => {
    // credentials_encrypted stores encrypted data — never plain text
    const encryptedCreds = JSON.stringify({
      encrypted: true,
      iv: "abc123",
      data: "encryptedbase64data==",
      algorithm: "aes-256-gcm",
    });

    await connection.execute(
      `INSERT INTO cms_connections (id, business_id, platform, site_url, credentials_encrypted, connection_status)
       VALUES (?, ?, 'wordpress', ?, ?, 'connected')`,
      [connectionId, businessId, "https://cmstest.com", encryptedCreds]
    );
  });

  it("reads the cms_connection back with credentials_encrypted as JSONB", async () => {
    const rows = await query<{
      id: string;
      business_id: string;
      platform: string;
      connection_status: string;
      credentials_encrypted: string;
    }>(
      `SELECT id, business_id, platform, connection_status, credentials_encrypted
       FROM cms_connections WHERE id = ?`,
      [connectionId]
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.platform).toBe("wordpress");
    expect(row.connection_status).toBe("connected");

    const creds = typeof row.credentials_encrypted === "string"
      ? JSON.parse(row.credentials_encrypted)
      : row.credentials_encrypted;
    expect(creds.encrypted).toBe(true);
    expect(creds.algorithm).toBe("aes-256-gcm");
    // Verify plain-text credentials are NOT stored
    expect(creds.password).toBeUndefined();
    expect(creds.api_key_plain).toBeUndefined();
  });

  it("enforces platform enum (rejects invalid value)", async () => {
    await expect(
      connection.execute(
        `INSERT INTO cms_connections (id, business_id, platform, site_url, credentials_encrypted)
         VALUES (?, ?, 'squarespace', ?, '{}')`,
        [testId(), businessId, "https://x.com"]
      )
    ).rejects.toThrow();
  });

  afterAll(async () => {
    await connection.execute("DELETE FROM cms_connections WHERE id = ?", [connectionId]);
    await connection.execute("DELETE FROM businesses WHERE id = ?", [businessId]);
    await connection.execute("DELETE FROM iaudit_users WHERE id = ?", [userId]);
  });
});

describe("Layer 1 — Test Insert and Read: posts", () => {
  const userId = testId();
  const businessId = testId();
  const postId = testId();

  beforeAll(async () => {
    await connection.execute(
      `INSERT INTO iaudit_users (id, email, password_hash, name, account_type)
       VALUES (?, ?, ?, ?, 'solo')`,
      [userId, `posts-test-${userId}@example.com`, "$2b$10$hash", "Posts Test User"]
    );
    await connection.execute(
      `INSERT INTO businesses (id, user_id, business_name, website_url, industry, location,
        brand_voice, tone, target_audience, uvp, services, primary_cta_url, primary_cta_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      [businessId, userId, "Posts Test Biz", "https://poststest.com", "Tech", "Brisbane, QLD",
        "Voice", "Bold", "Audience", "UVP", "https://poststest.com/cta", "Get Started"]
    );
  });

  it("inserts a post with all required fields and audit_results JSONB", async () => {
    const auditResults = JSON.stringify({
      P1: { pass: true, note: "Keyword density 1.2%" },
      P2: { pass: false, note: "Keyword missing from H1" },
      P7: { pass: true, note: "Meta title 52 chars" },
    });

    await connection.execute(
      `INSERT INTO posts (id, business_id, cms_post_id, cms_platform, title, body_original,
        url, status, author_id_cms, author_name_cms, focus_keyword, keyword_source,
        audit_score, audit_grade, audit_results, cannibalization_flag)
       VALUES (?, ?, ?, 'wordpress', ?, ?, ?, 'published', ?, ?, ?, 'cms_scraped', 11, 'needs_work', ?, false)`,
      [
        postId, businessId, "wp-post-123",
        "How to Install a Pool in Sydney",
        "<h1>How to Install a Pool</h1><p>Content here...</p>",
        "https://poststest.com/blog/pool-installation-sydney",
        "author-1", "Jane Smith",
        "pool installation sydney",
        auditResults,
      ]
    );
  });

  it("reads the post back with all fields correct", async () => {
    const rows = await query<{
      id: string;
      business_id: string;
      cms_post_id: string;
      cms_platform: string;
      title: string;
      status: string;
      focus_keyword: string;
      keyword_source: string;
      audit_score: number;
      audit_grade: string;
      audit_results: string;
      body_rewritten: string | null;
      body_approved: string | null;
      cannibalization_flag: number;
    }>(
      `SELECT id, business_id, cms_post_id, cms_platform, title, status, focus_keyword,
              keyword_source, audit_score, audit_grade, audit_results,
              body_rewritten, body_approved, cannibalization_flag
       FROM posts WHERE id = ?`,
      [postId]
    );
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.id).toBe(postId);
    expect(row.business_id).toBe(businessId);
    expect(row.cms_post_id).toBe("wp-post-123");
    expect(row.cms_platform).toBe("wordpress");
    expect(row.title).toBe("How to Install a Pool in Sydney");
    expect(row.status).toBe("published");
    expect(row.focus_keyword).toBe("pool installation sydney");
    expect(row.keyword_source).toBe("cms_scraped");
    expect(row.audit_score).toBe(11);
    expect(row.audit_grade).toBe("needs_work");
    expect(row.body_rewritten).toBeNull();
    expect(row.body_approved).toBeNull();
    expect(row.cannibalization_flag).toBe(0);

    // JSONB audit_results
    const results = typeof row.audit_results === "string"
      ? JSON.parse(row.audit_results)
      : row.audit_results;
    expect(results.P1.pass).toBe(true);
    expect(results.P2.pass).toBe(false);
  });

  it("enforces status enum (rejects invalid value)", async () => {
    await expect(
      connection.execute(
        `INSERT INTO posts (id, business_id, cms_post_id, cms_platform, title, body_original,
          url, status, author_id_cms, author_name_cms)
         VALUES (?, ?, ?, 'wordpress', ?, ?, ?, 'archived', ?, ?)`,
        [testId(), businessId, "wp-999", "Bad Status Post", "<p>content</p>",
          "https://poststest.com/blog/bad", "author-1", "Jane Smith"]
      )
    ).rejects.toThrow();
  });

  it("enforces audit_grade enum (rejects invalid value)", async () => {
    await expect(
      connection.execute(
        `INSERT INTO posts (id, business_id, cms_post_id, cms_platform, title, body_original,
          url, status, author_id_cms, author_name_cms, audit_grade)
         VALUES (?, ?, ?, 'wordpress', ?, ?, ?, 'published', ?, ?, 'excellent')`,
        [testId(), businessId, "wp-998", "Bad Grade Post", "<p>content</p>",
          "https://poststest.com/blog/bad2", "author-1", "Jane Smith"]
      )
    ).rejects.toThrow();
  });

  afterAll(async () => {
    await connection.execute("DELETE FROM posts WHERE id = ?", [postId]);
    await connection.execute("DELETE FROM businesses WHERE id = ?", [businessId]);
    await connection.execute("DELETE FROM iaudit_users WHERE id = ?", [userId]);
  });
});

describe("Layer 1 — Test Insert and Read: credit_transactions", () => {
  const userId = testId();
  const businessId = testId();
  const postId = testId();
  const txId1 = testId();
  const txId2 = testId();
  const txId3 = testId();

  beforeAll(async () => {
    await connection.execute(
      `INSERT INTO iaudit_users (id, email, password_hash, name, account_type)
       VALUES (?, ?, ?, ?, 'solo')`,
      [userId, `credits-test-${userId}@example.com`, "$2b$10$hash", "Credits Test User"]
    );
    await connection.execute(
      `INSERT INTO businesses (id, user_id, business_name, website_url, industry, location,
        brand_voice, tone, target_audience, uvp, services, primary_cta_url, primary_cta_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      [businessId, userId, "Credits Test Biz", "https://creditstest.com", "Tech", "Perth, WA",
        "Voice", "Conversational", "Audience", "UVP", "https://creditstest.com/cta", "Buy Now"]
    );
    await connection.execute(
      `INSERT INTO posts (id, business_id, cms_post_id, cms_platform, title, body_original,
        url, status, author_id_cms, author_name_cms)
       VALUES (?, ?, ?, 'wordpress', ?, ?, ?, 'draft', ?, ?)`,
      [postId, businessId, "wp-tx-test", "Credit Test Post", "<p>content</p>",
        "https://creditstest.com/blog/test", "author-1", "Test Author"]
    );
  });

  it("inserts a purchase transaction (positive credits_delta)", async () => {
    await connection.execute(
      `INSERT INTO credit_transactions (id, user_id, type, credits_delta, stripe_payment_intent_id)
       VALUES (?, ?, 'purchase', 50, ?)`,
      [txId1, userId, "pi_test_stripe_intent_123"]
    );
  });

  it("inserts a use transaction (negative credits_delta) linked to a post", async () => {
    await connection.execute(
      `INSERT INTO credit_transactions (id, user_id, type, credits_delta, post_id)
       VALUES (?, ?, 'use', -1, ?)`,
      [txId2, userId, postId]
    );
  });

  it("inserts an admin_grant transaction with a note", async () => {
    await connection.execute(
      `INSERT INTO credit_transactions (id, user_id, type, credits_delta, note)
       VALUES (?, ?, 'admin_grant', 10, ?)`,
      [txId3, userId, "Complimentary credits from Rachel"]
    );
  });

  it("reads all three transactions back correctly", async () => {
    const rows = await query<{
      id: string;
      type: string;
      credits_delta: number;
      post_id: string | null;
      stripe_payment_intent_id: string | null;
      note: string | null;
    }>(
      `SELECT id, type, credits_delta, post_id, stripe_payment_intent_id, note
       FROM credit_transactions WHERE user_id = ? ORDER BY created_at`,
      [userId]
    );
    expect(rows.length).toBe(3);

    const purchase = rows.find((r) => r.type === "purchase");
    expect(purchase?.credits_delta).toBe(50);
    expect(purchase?.stripe_payment_intent_id).toBe("pi_test_stripe_intent_123");
    expect(purchase?.post_id).toBeNull();

    const use = rows.find((r) => r.type === "use");
    expect(use?.credits_delta).toBe(-1);
    expect(use?.post_id).toBe(postId);

    const grant = rows.find((r) => r.type === "admin_grant");
    expect(grant?.credits_delta).toBe(10);
    expect(grant?.note).toBe("Complimentary credits from Rachel");
  });

  it("enforces type enum (rejects invalid value)", async () => {
    await expect(
      connection.execute(
        `INSERT INTO credit_transactions (id, user_id, type, credits_delta)
         VALUES (?, ?, 'bonus', 5)`,
        [testId(), userId]
      )
    ).rejects.toThrow();
  });

  afterAll(async () => {
    await connection.execute("DELETE FROM credit_transactions WHERE user_id = ?", [userId]);
    await connection.execute("DELETE FROM posts WHERE id = ?", [postId]);
    await connection.execute("DELETE FROM businesses WHERE id = ?", [businessId]);
    await connection.execute("DELETE FROM iaudit_users WHERE id = ?", [userId]);
  });
});

// ---------------------------------------------------------------------------
// Section 5: Foreign key structural verification
// ---------------------------------------------------------------------------
describe("Layer 1 — Foreign Key Structural Verification", () => {
  it("businesses.user_id column exists and references iaudit_users.id by convention", async () => {
    const rows = await query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'businesses' AND COLUMN_NAME = 'user_id'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].DATA_TYPE).toBe("varchar"); // matches iaudit_users.id type
  });

  it("cms_connections.business_id column exists and matches businesses.id type", async () => {
    const rows = await query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cms_connections' AND COLUMN_NAME = 'business_id'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].DATA_TYPE).toBe("varchar");
  });

  it("posts.business_id column exists and matches businesses.id type", async () => {
    const rows = await query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'business_id'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].DATA_TYPE).toBe("varchar");
  });

  it("credit_transactions.user_id column exists and matches iaudit_users.id type", async () => {
    const rows = await query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
      `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_transactions' AND COLUMN_NAME = 'user_id'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].DATA_TYPE).toBe("varchar");
  });

  it("credit_transactions.post_id column is nullable (optional FK to posts)", async () => {
    const rows = await query<{ IS_NULLABLE: string }>(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'credit_transactions' AND COLUMN_NAME = 'post_id'`
    );
    expect(rows[0].IS_NULLABLE).toBe("YES");
  });
});

// ---------------------------------------------------------------------------
// Section 6: oauth_users table (scaffold compatibility)
// ---------------------------------------------------------------------------
describe("Layer 1 — oauth_users Table (Scaffold Compatibility)", () => {
  it("oauth_users table exists with openId unique constraint", async () => {
    const rows = await query<{ INDEX_NAME: string }>(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oauth_users'
       AND COLUMN_NAME = 'openId' AND NON_UNIQUE = 0`
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("oauth_users has role enum column", async () => {
    const rows = await query<{ DATA_TYPE: string }>(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'oauth_users' AND COLUMN_NAME = 'role'`
    );
    expect(rows[0].DATA_TYPE).toBe("enum");
  });
});

// ---------------------------------------------------------------------------
// Section 7: Actual foreign key enforcement (referential integrity)
// These tests verify the DB REJECTS inserts that violate FK constraints.
// ---------------------------------------------------------------------------
describe("Layer 1 — Foreign Key Enforcement (Referential Integrity)", () => {
  it("rejects businesses.user_id referencing a non-existent iaudit_users.id", async () => {
    await expect(
      connection.execute(
        `INSERT INTO businesses (id, user_id, business_name, website_url, industry, location,
          brand_voice, tone, target_audience, uvp, services, primary_cta_url, primary_cta_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
        [
          testId(), "non-existent-user-id-xyz",
          "Ghost Biz", "https://ghost.com", "Tech", "Sydney, NSW",
          "Voice", "Professional", "Audience", "UVP",
          "https://ghost.com/cta", "CTA",
        ]
      )
    ).rejects.toThrow(); // ER_NO_REFERENCED_ROW_2
  });

  it("rejects cms_connections.business_id referencing a non-existent businesses.id", async () => {
    await expect(
      connection.execute(
        `INSERT INTO cms_connections (id, business_id, platform, site_url, credentials_encrypted)
         VALUES (?, ?, 'wordpress', ?, '{}')`,
        [testId(), "non-existent-business-id-xyz", "https://ghost.com"]
      )
    ).rejects.toThrow();
  });

  it("rejects posts.business_id referencing a non-existent businesses.id", async () => {
    await expect(
      connection.execute(
        `INSERT INTO posts (id, business_id, cms_post_id, cms_platform, title, body_original,
          url, status, author_id_cms, author_name_cms)
         VALUES (?, ?, ?, 'wordpress', ?, ?, ?, 'draft', ?, ?)`,
        [
          testId(), "non-existent-business-id-xyz",
          "wp-ghost", "Ghost Post", "<p>ghost</p>",
          "https://ghost.com/blog/ghost", "author-ghost", "Ghost Author",
        ]
      )
    ).rejects.toThrow();
  });

  it("rejects credit_transactions.user_id referencing a non-existent iaudit_users.id", async () => {
    await expect(
      connection.execute(
        `INSERT INTO credit_transactions (id, user_id, type, credits_delta)
         VALUES (?, ?, 'purchase', 10)`,
        [testId(), "non-existent-user-id-xyz"]
      )
    ).rejects.toThrow();
  });

  it("verifies all 5 FK constraints exist in information_schema", async () => {
    const rows = await query<{ CONSTRAINT_NAME: string }>(
      `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE()
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'
       AND TABLE_NAME IN ('businesses','cms_connections','posts','credit_transactions')
       ORDER BY CONSTRAINT_NAME`
    );
    const names = rows.map((r) => r.CONSTRAINT_NAME).sort();
    expect(names).toContain("fk_businesses_user_id");
    expect(names).toContain("fk_cms_connections_business_id");
    expect(names).toContain("fk_posts_business_id");
    expect(names).toContain("fk_credit_transactions_user_id");
    expect(names).toContain("fk_credit_transactions_post_id");
    expect(names.length).toBe(5);
  });
});
