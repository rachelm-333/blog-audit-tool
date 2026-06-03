/**
 * credits.db.ts — Layer 12
 *
 * DB helpers for credit balance, credit transactions ledger, Stripe customer ID,
 * and top-up reminder email threshold tracking.
 */

import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "./db";
import { iauditUsers, creditTransactions, posts } from "../drizzle/schema";

// ---------------------------------------------------------------------------
// Credit balance
// ---------------------------------------------------------------------------

export async function getCreditsBalance(userId: string): Promise<{
  creditsRemaining: number;
  creditsTotalPurchased: number;
  creditsUsed: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      creditsRemaining: iauditUsers.creditsRemaining,
      creditsTotalPurchased: iauditUsers.creditsTotalPurchased,
    })
    .from(iauditUsers)
    .where(eq(iauditUsers.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("User not found");
  return {
    creditsRemaining: row.creditsRemaining,
    creditsTotalPurchased: row.creditsTotalPurchased,
    creditsUsed: row.creditsTotalPurchased - row.creditsRemaining,
  };
}

/**
 * Atomically increment credits_remaining and credits_total_purchased.
 * Called by the Stripe webhook handler after a successful payment.
 */
export async function incrementCredits(
  userId: string,
  amount: number,
  stripePaymentIntentId: string,
  packName: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(iauditUsers)
    .set({
      creditsRemaining: sql`${iauditUsers.creditsRemaining} + ${amount}`,
      creditsTotalPurchased: sql`${iauditUsers.creditsTotalPurchased} + ${amount}`,
    })
    .where(eq(iauditUsers.id, userId));

  await db.insert(creditTransactions).values({
    id: crypto.randomUUID(),
    userId,
    type: "purchase",
    creditsDelta: amount,
    stripePaymentIntentId,
    note: `${packName} — ${amount} credits purchased`,
  });
}

// ---------------------------------------------------------------------------
// Stripe customer ID
// ---------------------------------------------------------------------------

export async function getStripeCustomerId(
  userId: string
): Promise<string | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({ stripeCustomerId: iauditUsers.stripeCustomerId })
    .from(iauditUsers)
    .where(eq(iauditUsers.id, userId))
    .limit(1);
  return rows[0]?.stripeCustomerId ?? null;
}

export async function setStripeCustomerId(
  userId: string,
  stripeCustomerId: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(iauditUsers)
    .set({ stripeCustomerId })
    .where(eq(iauditUsers.id, userId));
}

// ---------------------------------------------------------------------------
// Credit history (ledger)
// ---------------------------------------------------------------------------

export interface CreditHistoryRow {
  id: string;
  date: Date;
  type: "purchase" | "use" | "admin_grant" | "refund";
  creditsDelta: number;
  postTitle: string | null;
  note: string | null;
  stripePaymentIntentId: string | null;
  balanceAfter: number;
}

export async function getCreditHistory(
  userId: string
): Promise<CreditHistoryRow[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Fetch all transactions ordered oldest-first so we can compute running balance
  const rows = await db
    .select({
      id: creditTransactions.id,
      createdAt: creditTransactions.createdAt,
      type: creditTransactions.type,
      creditsDelta: creditTransactions.creditsDelta,
      postId: creditTransactions.postId,
      note: creditTransactions.note,
      stripePaymentIntentId: creditTransactions.stripePaymentIntentId,
      postTitle: posts.title,
    })
    .from(creditTransactions)
    .leftJoin(posts, eq(creditTransactions.postId, posts.id))
    .where(eq(creditTransactions.userId, userId))
    .orderBy(creditTransactions.createdAt); // oldest first for running balance

  // Compute running balance from beginning of time
  // We need to know starting balance — derive from current balance and all deltas
  const { creditsRemaining } = await getCreditsBalance(userId);
  const totalDelta = rows.reduce((sum, r) => sum + r.creditsDelta, 0);
  // Starting balance = current balance - total of all deltas
  let runningBalance = creditsRemaining - totalDelta;

  const result: CreditHistoryRow[] = rows.map((r) => {
    runningBalance += r.creditsDelta;
    return {
      id: r.id,
      date: r.createdAt,
      type: r.type,
      creditsDelta: r.creditsDelta,
      postTitle: r.postTitle ?? null,
      note: r.note ?? null,
      stripePaymentIntentId: r.stripePaymentIntentId ?? null,
      balanceAfter: runningBalance,
    };
  });

  // Return newest first for display
  return result.reverse();
}

// ---------------------------------------------------------------------------
// Top-up reminder email threshold tracking
// ---------------------------------------------------------------------------

/**
 * Returns the current credits_remaining for a user.
 * Used by the webhook handler to check if a reminder email should be sent.
 */
export async function getCreditsRemainingForUser(
  userId: string
): Promise<number> {
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
 * Get user details needed for reminder emails.
 */
export async function getUserForEmail(userId: string): Promise<{
  email: string;
  name: string;
  creditsRemaining: number;
} | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      email: iauditUsers.email,
      name: iauditUsers.name,
      creditsRemaining: iauditUsers.creditsRemaining,
    })
    .from(iauditUsers)
    .where(eq(iauditUsers.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find a user by their Stripe customer ID.
 * Used by the webhook handler to identify which user made a payment.
 */
export async function getUserByStripeCustomerId(
  stripeCustomerId: string
): Promise<{ id: string; email: string; name: string; creditsRemaining: number } | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      id: iauditUsers.id,
      email: iauditUsers.email,
      name: iauditUsers.name,
      creditsRemaining: iauditUsers.creditsRemaining,
    })
    .from(iauditUsers)
    .where(eq(iauditUsers.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find a user by their iAudit user ID (for webhook metadata lookup).
 */
export async function getUserById(
  userId: string
): Promise<{ id: string; email: string; name: string; creditsRemaining: number } | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      id: iauditUsers.id,
      email: iauditUsers.email,
      name: iauditUsers.name,
      creditsRemaining: iauditUsers.creditsRemaining,
    })
    .from(iauditUsers)
    .where(eq(iauditUsers.id, userId))
    .limit(1);
  return rows[0] ?? null;
}
