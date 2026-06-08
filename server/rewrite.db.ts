/**
 * iAudit — Rewrite DB Helpers (Layer 7)
 *
 * Provides:
 *   getPostForRewrite        — fetch a post with all fields needed to run the rewrite
 *   setRewriteStatus         — set rewrite_status to 'running' / 'failed' / 'needs_manual_review'
 *   saveRewriteResult        — persist rewrite output (body, meta, schema, score, grade, paa, articleType)
 *   deductCredit             — atomically decrement credits_remaining by 1 and log credit_transactions
 *   refundCredit             — atomically increment credits_remaining by 1 and log refund transaction
 *   getCreditsRemaining      — return current credits_remaining for a user
 *   listPostsForBusiness     — all posts for a business (for internal link map)
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { posts, iauditUsers, creditTransactions } from "../drizzle/schema";
import type { RewriteResult } from "./rewrite.service";

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
/** Fetch a post with all fields needed to run the rewrite */
export async function getPostForRewrite(postId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      id: posts.id,
      businessId: posts.businessId,
      title: posts.title,
      bodyOriginal: posts.bodyOriginal,
      bodyRewritten: posts.bodyRewritten,
      url: posts.url,
      status: posts.status,
      publishDate: posts.publishDate,
      scheduledDate: posts.scheduledDate,
      focusKeyword: posts.focusKeyword,
      keywordSource: posts.keywordSource,
      metaTitleOriginal: posts.metaTitleOriginal,
      metaDescriptionOriginal: posts.metaDescriptionOriginal,
      metaTitleRewritten: posts.metaTitleRewritten,
      metaDescriptionRewritten: posts.metaDescriptionRewritten,
      auditScore: posts.auditScore,
      auditGrade: posts.auditGrade,
      auditResults: posts.auditResults,
      rewriteStatus: posts.rewriteStatus,
      rewriteScore: posts.rewriteScore,
      rewriteGrade: posts.rewriteGrade,
      cannibalizationFlag: posts.cannibalizationFlag,
      paaQuestion: posts.paaQuestion,
      articleType: posts.articleType,
      secondaryKeywords: posts.secondaryKeywords,
      rewriteMode: posts.rewriteMode,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return rows[0] ?? null;
}

/** List all posts for a business (for internal link map) */
export async function listPostsForBusiness(businessId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db
    .select({
      id: posts.id,
      url: posts.url,
      title: posts.title,
      status: posts.status,
      publishDate: posts.publishDate,
      scheduledDate: posts.scheduledDate,
    })
    .from(posts)
    .where(eq(posts.businessId, businessId));
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
/** Set rewrite_status */
export async function setRewriteStatus(
  postId: string,
  status: "pending" | "running" | "complete" | "failed" | "needs_manual_review" | "awaiting_review" | "approved"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(posts)
    .set({ rewriteStatus: status })
    .where(eq(posts.id, postId));
}

// ---------------------------------------------------------------------------
// Save Result
// ---------------------------------------------------------------------------
/** Persist rewrite output after a completed rewrite */
export async function saveRewriteResult(
  postId: string,
  result: RewriteResult
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(posts)
    .set({
      bodyRewritten: result.bodyRewritten,
      metaTitleRewritten: result.metaTitleRewritten,
      metaDescriptionRewritten: result.metaDescriptionRewritten,
      schemaJson: result.schemaJson as unknown as Record<string, unknown>,
      rewriteScore: result.rewriteScore,
      rewriteGrade: result.rewriteGrade,
      // If score >= 14, move to awaiting_review queue automatically
      // If score < 14, keep as complete (needs_manual_review is set by the router if needed)
      rewriteStatus: result.rewriteScore >= 14 ? "awaiting_review" : "complete",
      rewrittenAt: new Date(),
      paaQuestion: result.paaQuestion,
      articleType: result.articleType,
      rewriteMode: result.rewriteMode,
      // CRITICAL: Save the rewrite audit results so retries and the editor
      // use the latest audit breakdown (not the original pre-rewrite audit)
      auditResults: result.auditResult as unknown as Record<string, unknown>,
      auditScore: result.rewriteScore,
      auditGrade: result.rewriteGrade,
    })
    .where(eq(posts.id, postId));
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------
/** Return current credits_remaining for a user */
export async function getCreditsRemaining(userId: string): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({ creditsRemaining: iauditUsers.creditsRemaining })
    .from(iauditUsers)
    .where(eq(iauditUsers.id, userId))
    .limit(1);
  return rows[0]?.creditsRemaining ?? 0;
}

/**
 * Atomically deduct 1 credit from a user and log a credit_transactions row.
 * Throws if credits_remaining is already 0.
 */
export async function deductCredit(userId: string, postId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check credits first
  const credits = await getCreditsRemaining(userId);
  if (credits <= 0) {
    throw new Error("INSUFFICIENT_CREDITS");
  }

  // Decrement credits
  await db
    .update(iauditUsers)
    .set({ creditsRemaining: sql`${iauditUsers.creditsRemaining} - 1` })
    .where(eq(iauditUsers.id, userId));

  // Log the transaction
  await db.insert(creditTransactions).values({
    id: crypto.randomUUID(),
    userId,
    type: "use",
    creditsDelta: -1,
    postId,
    note: "Rewrite credit deduction",
  });
}

/**
 * Atomically refund 1 credit to a user and log a credit_transactions row.
 * Called when auto-retry also fails to reach score ≥ 13.
 */
export async function refundCredit(userId: string, postId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Increment credits
  await db
    .update(iauditUsers)
    .set({ creditsRemaining: sql`${iauditUsers.creditsRemaining} + 1` })
    .where(eq(iauditUsers.id, userId));

  // Log the refund transaction
  await db.insert(creditTransactions).values({
    id: crypto.randomUUID(),
    userId,
    type: "refund",
    creditsDelta: 1,
    postId,
    note: "Auto-retry failed — credit refunded",
  });
}
