/**
 * iAudit — Audit DB Helpers (Layer 6)
 *
 * Provides:
 *   getPostForAudit          — fetch a post with all fields needed to run the audit
 *   saveAuditResults         — persist audit_score, audit_grade, audit_results, audit_status, audited_at
 *   setAuditStatus           — set audit_status to 'running' or 'failed'
 *   listPostsForDashboard    — all posts for a business with audit fields for dashboard aggregation
 */

import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { posts } from "../drizzle/schema";
import type { AuditPoint } from "./audit.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditResultsJson {
  points: AuditPoint[];
  potentialScore: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a post with all fields needed to run the audit */
export async function getPostForAudit(postId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      id: posts.id,
      businessId: posts.businessId,
      title: posts.title,
      bodyOriginal: posts.bodyOriginal,
      url: posts.url,
      focusKeyword: posts.focusKeyword,
      metaTitleOriginal: posts.metaTitleOriginal,
      metaDescriptionOriginal: posts.metaDescriptionOriginal,
      auditStatus: posts.auditStatus,
      auditScore: posts.auditScore,
      auditGrade: posts.auditGrade,
      auditResults: posts.auditResults,
      auditedAt: posts.auditedAt,
      cannibalizationFlag: posts.cannibalizationFlag,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return rows[0] ?? null;
}

/** Set audit_status to 'running' or 'failed' */
export async function setAuditStatus(
  postId: string,
  status: "running" | "failed" | "pending"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(posts)
    .set({ auditStatus: status })
    .where(eq(posts.id, postId));
}

/** Persist audit results after a completed audit */
export async function saveAuditResults(
  postId: string,
  score: number,
  grade: "optimised" | "strong" | "needs_work" | "poor" | "critical",
  results: AuditResultsJson
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(posts)
    .set({
      auditScore: score,
      auditGrade: grade,
      auditResults: results as unknown as Record<string, unknown>,
      auditStatus: "complete",
      auditedAt: new Date(),
    })
    .where(eq(posts.id, postId));
}

/** List all posts for a business with audit fields for dashboard aggregation */
export async function listPostsForDashboard(businessId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db
    .select({
      id: posts.id,
      title: posts.title,
      url: posts.url,
      focusKeyword: posts.focusKeyword,
      auditStatus: posts.auditStatus,
      auditScore: posts.auditScore,
      auditGrade: posts.auditGrade,
      auditResults: posts.auditResults,
      auditedAt: posts.auditedAt,
      cannibalizationFlag: posts.cannibalizationFlag,
    })
    .from(posts)
    .where(eq(posts.businessId, businessId));
}
