/**
 * iAudit — Audit DB Helpers (Layer 6)
 *
 * Provides:
 *   getPostForAudit          — fetch a post with all fields needed to run the audit
 *   saveAuditResults         — persist audit_score, audit_grade, audit_results, audit_status, audited_at
 *   setAuditStatus           — set audit_status to 'running' or 'failed'
 *   listPostsForDashboard    — all posts for a business with audit fields for dashboard aggregation
 *   createAuditJob           — create a new audit_jobs row, return its id
 *   updateAuditJobProgress   — increment completed/failed counters
 *   finishAuditJob           — mark job as complete or failed
 *   getAuditJob              — fetch a job by id
 *   getLatestAuditJob        — fetch the most recent job for a business
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { auditJobs, posts } from "../drizzle/schema";
import type { AuditJob } from "../drizzle/schema";
import type { AuditPoint } from "./audit.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditResultsJson {
  points: AuditPoint[];
  potentialScore: number;
}

export type FailedPostEntry = { postId: string; title: string; error: string };

// ---------------------------------------------------------------------------
// Post helpers
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

// ---------------------------------------------------------------------------
// audit_jobs helpers
// ---------------------------------------------------------------------------

/** Create a new audit job row and return its id */
export async function createAuditJob(businessId: string, total: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = crypto.randomUUID();
  await db.insert(auditJobs).values({
    id,
    businessId,
    total,
    completed: 0,
    failed: 0,
    status: "running",
    failedPosts: [],
  });
  return id;
}

/** Increment completed/failed counters and optionally append a failed post entry */
export async function updateAuditJobProgress(
  jobId: string,
  opts: { completedDelta?: number; failedPost?: FailedPostEntry }
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(auditJobs).where(eq(auditJobs.id, jobId)).limit(1);
  if (!rows[0]) return;
  const current = rows[0];
  const newCompleted = (current.completed ?? 0) + (opts.completedDelta ?? 0);
  const newFailed = opts.failedPost ? (current.failed ?? 0) + 1 : (current.failed ?? 0);
  const existingFailed = (current.failedPosts as FailedPostEntry[] | null) ?? [];
  const newFailedPosts = opts.failedPost
    ? [...existingFailed, opts.failedPost]
    : existingFailed;
  await db
    .update(auditJobs)
    .set({
      completed: newCompleted,
      failed: newFailed,
      failedPosts: newFailedPosts,
    })
    .where(eq(auditJobs.id, jobId));
}

/** Mark a job as complete or failed */
export async function finishAuditJob(
  jobId: string,
  status: "complete" | "failed"
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(auditJobs)
    .set({ status, finishedAt: new Date() })
    .where(eq(auditJobs.id, jobId));
}

/** Get a job by id */
export async function getAuditJob(jobId: string): Promise<AuditJob | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(auditJobs).where(eq(auditJobs.id, jobId)).limit(1);
  return rows[0] ?? null;
}

/** Get the most recent job for a business (any status) */
export async function getLatestAuditJob(businessId: string): Promise<AuditJob | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select()
    .from(auditJobs)
    .where(eq(auditJobs.businessId, businessId))
    .orderBy(desc(auditJobs.startedAt))
    .limit(1);
  return rows[0] ?? null;
}
