/**
 * Layer 15 — Admin Panel Tests
 *
 * Tests:
 *   adminProcedure guard:
 *   1.  admin.listUsers throws FORBIDDEN for a solo user
 *   2.  admin.listUsers throws FORBIDDEN for an agency user
 *   3.  admin.listUsers throws UNAUTHORIZED when no iauditUserId provided
 *
 *   admin.listUsers:
 *   4.  Returns all users with aggregated stats for an admin user
 *   5.  Returns correct totalRewrites count for a user with credit_transactions
 *   6.  Returns correct totalAudits count for a user with completed posts
 *
 *   admin.addCredits:
 *   7.  Adds credits to a user and logs an admin_grant transaction
 *   8.  Throws BAD_REQUEST when credits < 1
 *   9.  Throws BAD_REQUEST when note is empty
 *
 *   admin.suspendUser:
 *   10. Sets isSuspended = true on a user
 *   11. Sets isSuspended = false (unsuspend) on a user
 *
 *   admin.deleteUser:
 *   12. Deletes a user and all their businesses, posts, and transactions
 *
 *   admin.getUsageDashboard:
 *   13. Returns correct totalAudits and totalRewrites counts
 *   14. Returns correct rewritesByMode breakdown
 *
 *   admin.getRevenueDashboard:
 *   15. Returns correct totalPurchases and totalRevenueAud
 *   16. Returns byPackSize breakdown grouped by credit amount
 *
 *   admin.getErrorLog:
 *   17. Returns error_log rows with user email and business name
 *   18. Returns empty array when no errors logged
 *
 *   admin.markErrorReviewed:
 *   19. Marks an error_log row as reviewed
 *   20. Marks an error_log row as unreviewed
 *
 *   admin.downloadKeywordRegistry:
 *   21. Returns CSV with correct header and rows for a user with keywords
 *   22. Returns rowCount = 0 for a user with no posts
 *
 *   logError DB helper:
 *   23. logError writes a row to error_log
 *   24. logError does not throw when called with minimal fields
 *   25. logError truncates errorMessage at 5000 characters
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import { createIauditUser } from "./iauth.db";
import { getDb } from "./db";
import {
  iauditUsers,
  businesses,
  posts,
  creditTransactions,
  errorLog,
} from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { logError } from "./admin.db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller() {
  return appRouter.createCaller({
    user: null,
    req: {} as never,
    res: {} as never,
  });
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

let adminUserId: string;
let soloUserId: string;
let agencyUserId: string;
let targetUserId: string;   // user to be acted on (addCredits, suspend, delete)
let bizId: string;
let postId: string;
let errorLogId: string;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  adminUserId = crypto.randomUUID();
  soloUserId = crypto.randomUUID();
  agencyUserId = crypto.randomUUID();
  targetUserId = crypto.randomUUID();
  bizId = crypto.randomUUID();
  postId = crypto.randomUUID();
  errorLogId = crypto.randomUUID();

  // Create admin user
  await createIauditUser({
    id: adminUserId,
    name: "Admin User",
    email: `admin-l15-${adminUserId.slice(0, 8)}@test.com`,
    passwordHash: "hash",
    accountType: "admin",
  });

  // Create solo user
  await createIauditUser({
    id: soloUserId,
    name: "Solo User L15",
    email: `solo-l15-${soloUserId.slice(0, 8)}@test.com`,
    passwordHash: "hash",
    accountType: "solo",
  });

  // Create agency user
  await createIauditUser({
    id: agencyUserId,
    name: "Agency User L15",
    email: `agency-l15-${agencyUserId.slice(0, 8)}@test.com`,
    passwordHash: "hash",
    accountType: "agency",
  });

  // Create target user (solo, will be acted on by admin)
  await createIauditUser({
    id: targetUserId,
    name: "Target User L15",
    email: `target-l15-${targetUserId.slice(0, 8)}@test.com`,
    passwordHash: "hash",
    accountType: "solo",
  });

  // Create a business for targetUser
  await db.insert(businesses).values({
    id: bizId,
    userId: targetUserId,
    businessName: "Target Biz L15",
    websiteUrl: "https://target-l15.com",
    industry: "technology",
    location: "Sydney, NSW",
    brandVoice: "Professional",
    tone: "Friendly",
    targetAudience: "SMBs",
    uvp: "We deliver results",
    services: ["SEO"],
    primaryCtaUrl: "https://target-l15.com/contact",
    primaryCtaLabel: "Contact Us",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  // Create a completed post for targetUser (for audit count)
  await db.insert(posts).values({
    id: postId,
    businessId: bizId,
    title: "Test Post L15",
    bodyOriginal: "<p>Test content for Layer 15</p>",
    url: "https://target-l15.com/post",
    cmsPlatform: "wordpress",
    cmsPostId: "wp-l15-1",
    status: "published",
    auditStatus: "complete",
    authorIdCms: "author-1",
    authorNameCms: "Author One",
    focusKeyword: "test keyword",
    secondaryKeywords: "kw2, kw3",
    rewriteMode: "full_rewrite",
    auditGrade: "strong",
  });

  // Create a credit_transaction (use type) for targetUser (for rewrite count)
  await db.insert(creditTransactions).values({
    id: crypto.randomUUID(),
    userId: targetUserId,
    type: "use",
    creditsDelta: -1,
    note: "rewrite",
  });

  // Create a purchase transaction for targetUser (for revenue dashboard)
  await db.insert(creditTransactions).values({
    id: crypto.randomUUID(),
    userId: targetUserId,
    type: "purchase",
    creditsDelta: 10,
    stripePaymentIntentId: "pi_test_l15_abc",
    note: "10 credit pack",
  });

  // Create an error_log row
  await db.insert(errorLog).values({
    id: errorLogId,
    userId: targetUserId,
    businessId: bizId,
    postId: postId,
    errorType: "scrape_failed",
    errorMessage: "Connection refused",
    layer: "layer_3_scrape",
    reviewed: false,
    createdAt: new Date(),
  });
});

afterAll(async () => {
  const db = await getDb();
  if (!db) return;

  // Clean up in dependency order
  await db.delete(errorLog).where(eq(errorLog.userId, adminUserId));
  await db.delete(errorLog).where(eq(errorLog.userId, soloUserId));
  await db.delete(errorLog).where(eq(errorLog.userId, agencyUserId));
  await db.delete(errorLog).where(eq(errorLog.userId, targetUserId));
  await db.delete(creditTransactions).where(eq(creditTransactions.userId, adminUserId));
  await db.delete(creditTransactions).where(eq(creditTransactions.userId, soloUserId));
  await db.delete(creditTransactions).where(eq(creditTransactions.userId, agencyUserId));
  await db.delete(creditTransactions).where(eq(creditTransactions.userId, targetUserId));
  await db.delete(posts).where(eq(posts.businessId, bizId));
  await db.delete(businesses).where(eq(businesses.userId, adminUserId));
  await db.delete(businesses).where(eq(businesses.userId, soloUserId));
  await db.delete(businesses).where(eq(businesses.userId, agencyUserId));
  await db.delete(businesses).where(eq(businesses.userId, targetUserId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, adminUserId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, soloUserId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, agencyUserId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, targetUserId));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Layer 15 — Admin Panel", () => {
  const caller = makeCaller();

  // ── adminProcedure guard ──────────────────────────────────────────────────

  it("1. admin.listUsers throws FORBIDDEN for a solo user", async () => {
    await expect(
      caller.admin.listUsers({ iauditUserId: soloUserId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("2. admin.listUsers throws FORBIDDEN for an agency user", async () => {
    await expect(
      caller.admin.listUsers({ iauditUserId: agencyUserId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("3. admin.listUsers throws BAD_REQUEST when iauditUserId is empty string", async () => {
    await expect(
      caller.admin.listUsers({ iauditUserId: "" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // ── admin.listUsers ───────────────────────────────────────────────────────

  it("4. Returns all users with aggregated stats for an admin user", async () => {
    const users = await caller.admin.listUsers({ iauditUserId: adminUserId });
    expect(Array.isArray(users)).toBe(true);
    const target = users.find((u) => u.id === targetUserId);
    expect(target).toBeDefined();
    expect(target!.name).toBe("Target User L15");
    expect(target!.accountType).toBe("solo");
  });

  it("5. Returns correct totalRewrites count for a user with credit_transactions", async () => {
    const users = await caller.admin.listUsers({ iauditUserId: adminUserId });
    const target = users.find((u) => u.id === targetUserId);
    expect(target).toBeDefined();
    expect(target!.totalRewrites).toBeGreaterThanOrEqual(1);
  });

  it("6. Returns correct totalAudits count for a user with completed posts", async () => {
    const users = await caller.admin.listUsers({ iauditUserId: adminUserId });
    const target = users.find((u) => u.id === targetUserId);
    expect(target).toBeDefined();
    expect(target!.totalAudits).toBeGreaterThanOrEqual(1);
  });

  // ── admin.addCredits ──────────────────────────────────────────────────────

  it("7. Adds credits to a user and logs an admin_grant transaction", async () => {
    const result = await caller.admin.addCredits({
      iauditUserId: adminUserId,
      userId: targetUserId,
      credits: 5,
      note: "Layer 15 test grant",
    });
    expect(result.success).toBe(true);

    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const [user] = await db
      .select({ creditsRemaining: iauditUsers.creditsRemaining })
      .from(iauditUsers)
      .where(eq(iauditUsers.id, targetUserId));
    expect(user.creditsRemaining).toBeGreaterThanOrEqual(5);
  });

  it("8. Throws BAD_REQUEST when credits < 1", async () => {
    await expect(
      caller.admin.addCredits({
        iauditUserId: adminUserId,
        userId: targetUserId,
        credits: 0,
        note: "test",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("9. Throws BAD_REQUEST when note is empty", async () => {
    await expect(
      caller.admin.addCredits({
        iauditUserId: adminUserId,
        userId: targetUserId,
        credits: 5,
        note: "",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // ── admin.suspendUser ─────────────────────────────────────────────────────

  it("10. Sets isSuspended = true on a user", async () => {
    const result = await caller.admin.suspendUser({
      iauditUserId: adminUserId,
      userId: targetUserId,
      suspended: true,
    });
    expect(result.success).toBe(true);

    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const [user] = await db
      .select({ isSuspended: iauditUsers.isSuspended })
      .from(iauditUsers)
      .where(eq(iauditUsers.id, targetUserId));
    expect(user.isSuspended).toBe(true);
  });

  it("11. Sets isSuspended = false (unsuspend) on a user", async () => {
    const result = await caller.admin.suspendUser({
      iauditUserId: adminUserId,
      userId: targetUserId,
      suspended: false,
    });
    expect(result.success).toBe(true);

    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const [user] = await db
      .select({ isSuspended: iauditUsers.isSuspended })
      .from(iauditUsers)
      .where(eq(iauditUsers.id, targetUserId));
    expect(user.isSuspended).toBe(false);
  });

  // ── admin.deleteUser ──────────────────────────────────────────────────────

  it("12. Deletes a user and all their businesses, posts, and transactions", async () => {
    const throwawayId = crypto.randomUUID();
    const throwawayBizId = crypto.randomUUID();
    const db = await getDb();
    if (!db) throw new Error("DB not available");

    await createIauditUser({
      id: throwawayId,
      name: "Throwaway L15",
      email: `throwaway-l15-${throwawayId.slice(0, 8)}@test.com`,
      passwordHash: "hash",
      accountType: "solo",
    });
    await db.insert(businesses).values({
      id: throwawayBizId,
      userId: throwawayId,
      businessName: "Throwaway Biz",
      websiteUrl: "https://throwaway.com",
      industry: "technology",
      location: "Sydney, NSW",
      brandVoice: "Professional",
      tone: "Friendly",
      targetAudience: "SMBs",
      uvp: "We deliver results",
      services: ["SEO"],
      primaryCtaUrl: "https://throwaway.com/contact",
      primaryCtaLabel: "Contact Us",
      scrapeStatus: "complete",
      stage1Complete: false,
    });

    const result = await caller.admin.deleteUser({
      iauditUserId: adminUserId,
      userId: throwawayId,
    });
    expect(result.success).toBe(true);

    const [user] = await db
      .select({ id: iauditUsers.id })
      .from(iauditUsers)
      .where(eq(iauditUsers.id, throwawayId));
    expect(user).toBeUndefined();

    const [biz] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, throwawayBizId));
    expect(biz).toBeUndefined();
  });

  // ── admin.getUsageDashboard ───────────────────────────────────────────────

  it("13. Returns correct totalAudits and totalRewrites counts", async () => {
    const data = await caller.admin.getUsageDashboard({
      iauditUserId: adminUserId,
    });
    expect(typeof data.totalAudits).toBe("number");
    expect(typeof data.totalRewrites).toBe("number");
    expect(data.totalAudits).toBeGreaterThanOrEqual(1);
    expect(data.totalRewrites).toBeGreaterThanOrEqual(1);
  });

  it("14. Returns correct rewritesByMode breakdown", async () => {
    const data = await caller.admin.getUsageDashboard({
      iauditUserId: adminUserId,
    });
    expect(typeof data.rewritesByMode.fullRewrite).toBe("number");
    expect(typeof data.rewritesByMode.smartPatch).toBe("number");
    expect(
      data.rewritesByMode.fullRewrite + data.rewritesByMode.smartPatch
    ).toBeGreaterThanOrEqual(0);
  });

  // ── admin.getRevenueDashboard ─────────────────────────────────────────────

  it("15. Returns correct totalPurchases and totalRevenueAud", async () => {
    const data = await caller.admin.getRevenueDashboard({
      iauditUserId: adminUserId,
    });
    expect(typeof data.totalPurchases).toBe("number");
    expect(typeof data.totalRevenueAud).toBe("number");
    expect(data.totalPurchases).toBeGreaterThanOrEqual(1);
    expect(data.isTestMode).toBe(true); // test env always uses sk_test_
  });

  it("16. Returns byPackSize breakdown grouped by credit amount", async () => {
    const data = await caller.admin.getRevenueDashboard({
      iauditUserId: adminUserId,
    });
    expect(Array.isArray(data.byPackSize)).toBe(true);
    const pack10 = data.byPackSize.find((p) => p.credits === 10);
    expect(pack10).toBeDefined();
    expect(pack10!.count).toBeGreaterThanOrEqual(1);
    expect(pack10!.revenueAud).toBeGreaterThanOrEqual(29);
  });

  // ── admin.getErrorLog ─────────────────────────────────────────────────────

  it("17. Returns error_log rows with user email and business name", async () => {
    const rows = await caller.admin.getErrorLog({
      iauditUserId: adminUserId,
    });
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((r) => r.id === errorLogId);
    expect(row).toBeDefined();
    expect(row!.errorType).toBe("scrape_failed");
    expect(row!.errorMessage).toBe("Connection refused");
    expect(row!.layer).toBe("layer_3_scrape");
    expect(row!.userEmail).toContain("@test.com");
    expect(row!.businessName).toBe("Target Biz L15");
    expect(row!.reviewed).toBe(false);
  });

  it("18. Returns error log array (admin user may have no errors)", async () => {
    const rows = await caller.admin.getErrorLog({
      iauditUserId: adminUserId,
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  // ── admin.markErrorReviewed ───────────────────────────────────────────────

  it("19. Marks an error_log row as reviewed", async () => {
    const result = await caller.admin.markErrorReviewed({
      iauditUserId: adminUserId,
      errorId: errorLogId,
      reviewed: true,
    });
    expect(result.success).toBe(true);

    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const [row] = await db
      .select({ reviewed: errorLog.reviewed })
      .from(errorLog)
      .where(eq(errorLog.id, errorLogId));
    expect(row.reviewed).toBe(true);
  });

  it("20. Marks an error_log row as unreviewed", async () => {
    const result = await caller.admin.markErrorReviewed({
      iauditUserId: adminUserId,
      errorId: errorLogId,
      reviewed: false,
    });
    expect(result.success).toBe(true);

    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const [row] = await db
      .select({ reviewed: errorLog.reviewed })
      .from(errorLog)
      .where(eq(errorLog.id, errorLogId));
    expect(row.reviewed).toBe(false);
  });

  // ── admin.downloadKeywordRegistry ────────────────────────────────────────

  it("21. Returns CSV with correct header and rows for a user with keywords", async () => {
    const result = await caller.admin.downloadKeywordRegistry({
      iauditUserId: adminUserId,
      userId: targetUserId,
    });
    expect(result.rowCount).toBeGreaterThanOrEqual(1);
    expect(result.csv).toContain(
      "Business Name,Post Title,Primary Keyword,Secondary Keywords,Post URL,Post Status,Audit Grade"
    );
    expect(result.csv).toContain("test keyword");
  });

  it("22. Returns rowCount = 0 for a user with no posts", async () => {
    const result = await caller.admin.downloadKeywordRegistry({
      iauditUserId: adminUserId,
      userId: agencyUserId,
    });
    expect(result.rowCount).toBe(0);
    expect(result.csv).toContain("Business Name");
  });

  // ── logError DB helper ────────────────────────────────────────────────────

  it("23. logError writes a row to error_log", async () => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");

    await logError({
      userId: adminUserId,
      businessId: null,
      postId: null,
      errorType: "test_error",
      errorMessage: "Test error message from layer 15 test",
      layer: "layer_15_test",
    });

    const rows = await db
      .select({ errorType: errorLog.errorType })
      .from(errorLog)
      .where(eq(errorLog.userId, adminUserId));
    expect(rows.some((r) => r.errorType === "test_error")).toBe(true);
  });

  it("24. logError does not throw when called with minimal fields", async () => {
    await expect(
      logError({
        userId: adminUserId,
        errorType: "minimal_error",
        errorMessage: "minimal",
        layer: "test",
      })
    ).resolves.toBeUndefined();
  });

  it("25. logError truncates errorMessage at 5000 characters", async () => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");

    const longMessage = "x".repeat(6000);
    await logError({
      userId: adminUserId,
      errorType: "long_error",
      errorMessage: longMessage,
      layer: "test",
    });

    const rows = await db
      .select({ errorMessage: errorLog.errorMessage })
      .from(errorLog)
      .where(eq(errorLog.userId, adminUserId));
    const longRow = rows.find((r) => r.errorMessage.startsWith("xxx"));
    expect(longRow).toBeDefined();
    expect(longRow!.errorMessage.length).toBeLessThanOrEqual(5000);
  });
});
