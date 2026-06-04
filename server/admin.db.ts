/**
 * admin.db.ts — Admin panel database helpers (Layer 15)
 *
 * All helpers here are called only from the admin tRPC router.
 * They operate across all users and must never be exposed to non-admin callers.
 */
import { randomUUID } from "crypto";
import { and, asc, count, desc, eq, isNotNull, sql, sum } from "drizzle-orm";
import { getDb } from "./db";
import {
  businesses,
  creditTransactions,
  cmsConnections,
  errorLog,
  freeRewrites,
  iauditUsers,
  posts,
} from "../drizzle/schema";

// ---------------------------------------------------------------------------
// logError — write a row to error_log (fire-and-forget safe)
// ---------------------------------------------------------------------------
export interface LogErrorInput {
  userId: string;
  businessId?: string | null;
  postId?: string | null;
  errorType: string;
  errorMessage: string;
  layer: string;
}

export async function logError(input: LogErrorInput): Promise<void> {
  try {
    const db = await getDb();
  if (!db) throw new Error("Database not available");
    await db.insert(errorLog).values({
      id: randomUUID(),
      userId: input.userId,
      businessId: input.businessId ?? null,
      postId: input.postId ?? null,
      errorType: input.errorType,
      errorMessage: input.errorMessage.slice(0, 5000),
      layer: input.layer,
      reviewed: false,
    });
  } catch {
    // logError must never throw — it is called in catch blocks
  }
}

// ---------------------------------------------------------------------------
// listAllUsers — returns all iaudit_users with aggregated stats
// ---------------------------------------------------------------------------
export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  accountType: "solo" | "agency" | "admin";
  creditsRemaining: number;
  isSuspended: boolean;
  createdAt: Date;
  totalRewrites: number;
  totalAudits: number;
}

export async function listAllUsers(): Promise<AdminUserRow[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const users = await db
    .select({
      id: iauditUsers.id,
      name: iauditUsers.name,
      email: iauditUsers.email,
      accountType: iauditUsers.accountType,
      creditsRemaining: iauditUsers.creditsRemaining,
      isSuspended: iauditUsers.isSuspended,
      createdAt: iauditUsers.createdAt,
    })
    .from(iauditUsers)
    .orderBy(asc(iauditUsers.createdAt));

  const rewriteCounts = await db
    .select({
      userId: creditTransactions.userId,
      total: count(creditTransactions.id),
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.type, "use"))
    .groupBy(creditTransactions.userId);

  const rewriteMap = new Map<string, number>(
    rewriteCounts.map((r) => [r.userId, r.total])
  );

  const auditCounts = await db
    .select({
      userId: businesses.userId,
      total: count(posts.id),
    })
    .from(posts)
    .innerJoin(businesses, eq(posts.businessId, businesses.id))
    .where(eq(posts.auditStatus, "complete"))
    .groupBy(businesses.userId);

  const auditMap = new Map<string, number>(
    auditCounts.map((a) => [a.userId, a.total])
  );

  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    accountType: u.accountType as "solo" | "agency" | "admin",
    creditsRemaining: u.creditsRemaining,
    isSuspended: u.isSuspended,
    createdAt: u.createdAt,
    totalRewrites: rewriteMap.get(u.id) ?? 0,
    totalAudits: auditMap.get(u.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// addCreditsToUser — increment credits_remaining and log admin_grant transaction
// ---------------------------------------------------------------------------
export async function addCreditsToUser(
  userId: string,
  credits: number,
  note: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(iauditUsers)
    .set({
      creditsRemaining: sql`${iauditUsers.creditsRemaining} + ${credits}`,
      creditsTotalPurchased: sql`${iauditUsers.creditsTotalPurchased} + ${credits}`,
    })
    .where(eq(iauditUsers.id, userId));

  await db.insert(creditTransactions).values({
    id: randomUUID(),
    userId,
    type: "admin_grant",
    creditsDelta: credits,
    note,
  });
}

// ---------------------------------------------------------------------------
// setUserSuspended — toggle isSuspended on a user row
// ---------------------------------------------------------------------------
export async function setUserSuspended(
  userId: string,
  suspended: boolean
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(iauditUsers)
    .set({ isSuspended: suspended })
    .where(eq(iauditUsers.id, userId));
}

// ---------------------------------------------------------------------------
// deleteUserAndData — hard-delete a user and all associated data
// Order: error_log → credit_transactions → posts → cms_connections → businesses → iaudit_users
// ---------------------------------------------------------------------------
export async function deleteUserAndData(userId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. Get all business IDs for this user
  const userBusinesses = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.userId, userId));
  const businessIds = userBusinesses.map((b: { id: string }) => b.id);

  // 2. Delete error_log rows for this user
  await db.delete(errorLog).where(eq(errorLog.userId, userId));

  // 3. Delete credit_transactions for this user
  await db
    .delete(creditTransactions)
    .where(eq(creditTransactions.userId, userId));

  // 4. Delete posts and cms_connections for this user's businesses
  if (businessIds.length > 0) {
    const idList = sql.join(
      businessIds.map((id: string) => sql`${id}`),
      sql`, `
    );
    await db.delete(posts).where(sql`${posts.businessId} IN (${idList})`);
    await db
      .delete(cmsConnections)
      .where(sql`${cmsConnections.businessId} IN (${idList})`);
  }

  // 5. Delete businesses
  await db.delete(businesses).where(eq(businesses.userId, userId));

  // 6. Delete the user
  await db.delete(iauditUsers).where(eq(iauditUsers.id, userId));
}

// ---------------------------------------------------------------------------
// getUsageDashboard — platform-wide usage stats
// ---------------------------------------------------------------------------
export interface UsageDashboard {
  totalAudits: number;
  totalRewrites: number;
  totalFreeRewrites: number;
  rewritesByMode: { fullRewrite: number; smartPatch: number };
  perUser: {
    userId: string;
    name: string;
    email: string;
    auditCount: number;
    rewriteCount: number;
    creditsConsumed: number;
  }[];
}

export async function getUsageDashboard(): Promise<UsageDashboard> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [auditRow] = await db
    .select({ total: count(posts.id) })
    .from(posts)
    .where(eq(posts.auditStatus, "complete"));

  const [rewriteRow] = await db
    .select({ total: count(creditTransactions.id) })
    .from(creditTransactions)
    .where(eq(creditTransactions.type, "use"));

  const [freeRow] = await db
    .select({ total: count(freeRewrites.id) })
    .from(freeRewrites);

  const modeRows = await db
    .select({
      mode: posts.rewriteMode,
      total: count(posts.id),
    })
    .from(posts)
    .where(eq(posts.rewriteStatus, "complete"))
    .groupBy(posts.rewriteMode);

  const fullRewrite =
    modeRows.find((r: { mode: string | null; total: number }) => r.mode === "full_rewrite")?.total ?? 0;
  const smartPatch =
    modeRows.find((r: { mode: string | null; total: number }) => r.mode === "smart_patch")?.total ?? 0;

  const allUsers = await db
    .select({
      id: iauditUsers.id,
      name: iauditUsers.name,
      email: iauditUsers.email,
    })
    .from(iauditUsers)
    .where(sql`${iauditUsers.accountType} != 'admin'`)
    .orderBy(asc(iauditUsers.createdAt));

  const auditCounts = await db
    .select({
      userId: businesses.userId,
      total: count(posts.id),
    })
    .from(posts)
    .innerJoin(businesses, eq(posts.businessId, businesses.id))
    .where(eq(posts.auditStatus, "complete"))
    .groupBy(businesses.userId);

  const rewriteCounts = await db
    .select({
      userId: creditTransactions.userId,
      total: count(creditTransactions.id),
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.type, "use"))
    .groupBy(creditTransactions.userId);

  const creditConsumed = await db
    .select({
      userId: creditTransactions.userId,
      total: sum(sql`ABS(${creditTransactions.creditsDelta})`),
    })
    .from(creditTransactions)
    .where(eq(creditTransactions.type, "use"))
    .groupBy(creditTransactions.userId);

  const auditMap = new Map<string, number>(
    auditCounts.map((r: { userId: string; total: number }) => [r.userId, r.total])
  );
  const rewriteMap = new Map<string, number>(
    rewriteCounts.map((r: { userId: string; total: number }) => [r.userId, r.total])
  );
  const creditMap = new Map<string, number>(
    creditConsumed.map((r: { userId: string; total: string | null }) => [
      r.userId,
      Number(r.total ?? 0),
    ])
  );

  return {
    totalAudits: auditRow?.total ?? 0,
    totalRewrites: rewriteRow?.total ?? 0,
    totalFreeRewrites: freeRow?.total ?? 0,
    rewritesByMode: { fullRewrite, smartPatch },
    perUser: allUsers.map((u: { id: string; name: string; email: string }) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      auditCount: auditMap.get(u.id) ?? 0,
      rewriteCount: rewriteMap.get(u.id) ?? 0,
      creditsConsumed: creditMap.get(u.id) ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// getRevenueDashboard — Stripe purchase stats
// ---------------------------------------------------------------------------
export interface RevenueDashboard {
  totalPurchases: number;
  totalRevenueAud: number;
  byPackSize: { credits: number; count: number; revenueAud: number }[];
  isTestMode: boolean;
}

export async function getRevenueDashboard(): Promise<RevenueDashboard> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const purchases = await db
    .select({
      creditsDelta: creditTransactions.creditsDelta,
      stripePaymentIntentId: creditTransactions.stripePaymentIntentId,
    })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.type, "purchase"),
        isNotNull(creditTransactions.stripePaymentIntentId)
      )
    );

  // Pricing map: credits → AUD price (matches Layer 12 pack definitions)
  const priceMap: Record<number, number> = {
    10: 29,
    25: 59,
    60: 99,
    150: 199,
  };

  const packMap = new Map<number, { count: number; revenueAud: number }>();
  for (const p of purchases) {
    const credits = p.creditsDelta;
    const existing = packMap.get(credits) ?? { count: 0, revenueAud: 0 };
    const price = priceMap[credits] ?? 0;
    packMap.set(credits, {
      count: existing.count + 1,
      revenueAud: existing.revenueAud + price,
    });
  }

  const byPackSize = Array.from(packMap.entries())
    .map(([credits, stats]) => ({ credits, ...stats }))
    .sort((a, b) => a.credits - b.credits);

  const totalRevenueAud = byPackSize.reduce((s, p) => s + p.revenueAud, 0);
  const isTestMode =
    (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_test_");

  return {
    totalPurchases: purchases.length,
    totalRevenueAud,
    byPackSize,
    isTestMode,
  };
}

// ---------------------------------------------------------------------------
// getErrorLog — all error_log rows with user email and business name
// ---------------------------------------------------------------------------
export interface ErrorLogRow {
  id: string;
  userId: string;
  userEmail: string;
  businessId: string | null;
  businessName: string | null;
  postId: string | null;
  errorType: string;
  errorMessage: string;
  layer: string;
  reviewed: boolean;
  createdAt: Date;
}

export async function getErrorLog(): Promise<ErrorLogRow[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({
      id: errorLog.id,
      userId: errorLog.userId,
      userEmail: iauditUsers.email,
      businessId: errorLog.businessId,
      businessName: businesses.businessName,
      postId: errorLog.postId,
      errorType: errorLog.errorType,
      errorMessage: errorLog.errorMessage,
      layer: errorLog.layer,
      reviewed: errorLog.reviewed,
      createdAt: errorLog.createdAt,
    })
    .from(errorLog)
    .innerJoin(iauditUsers, eq(errorLog.userId, iauditUsers.id))
    .leftJoin(businesses, eq(errorLog.businessId, businesses.id))
    .orderBy(desc(errorLog.createdAt))
    .limit(500);

  return rows.map((r: typeof rows[number]) => ({
    id: r.id,
    userId: r.userId,
    userEmail: r.userEmail,
    businessId: r.businessId ?? null,
    businessName: r.businessName ?? null,
    postId: r.postId ?? null,
    errorType: r.errorType,
    errorMessage: r.errorMessage,
    layer: r.layer,
    reviewed: r.reviewed,
    createdAt: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// markErrorReviewed — toggle reviewed on an error_log row
// ---------------------------------------------------------------------------
export async function markErrorReviewed(
  errorId: string,
  reviewed: boolean
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(errorLog)
    .set({ reviewed })
    .where(eq(errorLog.id, errorId));
}

// ---------------------------------------------------------------------------
// getKeywordRegistryForUser — CSV data for all businesses of a given user
// ---------------------------------------------------------------------------
export interface KeywordRegistryRow {
  businessName: string;
  postTitle: string;
  primaryKeyword: string;
  secondaryKeywords: string; // comma-separated
  postUrl: string;
  postStatus: string;
  auditGrade: string;
}

export async function getKeywordRegistryForUser(
  userId: string
): Promise<KeywordRegistryRow[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({
      businessName: businesses.businessName,
      postTitle: posts.title,
      primaryKeyword: posts.focusKeyword,
      secondaryKeywords: posts.secondaryKeywords,
      postUrl: posts.url,
      postStatus: posts.status,
      auditGrade: posts.auditGrade,
    })
    .from(posts)
    .innerJoin(businesses, eq(posts.businessId, businesses.id))
    .where(
      and(eq(businesses.userId, userId), isNotNull(posts.focusKeyword))
    )
    .orderBy(asc(businesses.businessName), asc(posts.title));

  return rows
    .filter((r: typeof rows[number]) => r.primaryKeyword)
    .map((r: typeof rows[number]) => ({
      businessName: r.businessName,
      postTitle: r.postTitle,
      primaryKeyword: r.primaryKeyword ?? "",
      secondaryKeywords: Array.isArray(r.secondaryKeywords)
        ? (r.secondaryKeywords as string[]).join(", ")
        : typeof r.secondaryKeywords === "string"
          ? (r.secondaryKeywords as string)
          : "",
      postUrl: r.postUrl,
      postStatus: r.postStatus,
      auditGrade: r.auditGrade ?? "",
    }));
}
