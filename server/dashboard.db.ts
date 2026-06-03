/**
 * dashboard.db.ts — Layer 11 query helpers.
 *
 * All queries are scoped to a single businessId.  The caller (tRPC router)
 * is responsible for verifying that the requesting user owns the business
 * before calling these helpers.
 *
 * Exported helpers:
 *   getDashboardStats   — aggregate stats for the 4 stat cards + grade breakdown
 *   getPostTableRows    — full post list with optional filter / sort
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "./db";
import { posts } from "../drizzle/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardStats {
  /** Average audit_score across all audited posts (0–16), or null if none audited */
  healthScore: number | null;
  /** Corresponding grade label for healthScore */
  healthGrade: "optimised" | "strong" | "needs_work" | "poor" | "critical" | null;
  /**
   * Average additional points that could be gained if all Poor and Critical
   * posts were rewritten to 15/16 (the minimum "Optimised" threshold is 15).
   * Shown as "+X pts".
   */
  scorePotential: number | null;
  /** Count of posts with Poor or Critical grade */
  poorAndCriticalCount: number;
  /** Estimated health score after fixing all Poor/Critical posts */
  projectedHealthScore: number | null;
  // Post counts by CMS status
  totalPosts: number;
  publishedCount: number;
  scheduledCount: number;
  draftCount: number;
  // Grade breakdown
  optimisedCount: number;
  strongCount: number;
  needsWorkCount: number;
  poorCount: number;
  criticalCount: number;
  // Cannibalisation
  cannibalisationCount: number;
  // Audit state
  auditedPostCount: number;
  /** True if at least one post exists but none have been audited */
  needsFirstAudit: boolean;
}

export interface PostTableRow {
  id: string;
  title: string;
  url: string;
  focusKeyword: string | null;
  status: "published" | "scheduled" | "draft";
  auditStatus: "pending" | "running" | "complete" | "failed" | null;
  auditScore: number | null;
  auditGrade: "optimised" | "strong" | "needs_work" | "poor" | "critical" | null;
  issueCount: number | null;
  cannibalizationFlag: boolean;
  rewriteStatus: "pending" | "running" | "complete" | "failed" | "needs_manual_review" | null;
  publishDate: Date | null;
  scheduledDate: Date | null;
  authorNameCms: string;
  keywordSource: "cms_scraped" | "ai_suggested" | "user_entered" | null;
}

export type GradeFilter =
  | "all"
  | "optimised"
  | "strong"
  | "needs_work"
  | "poor"
  | "critical";

export type StatusFilter = "all" | "published" | "scheduled" | "draft";
export type SortField = "score" | "grade" | "title";
export type SortDir = "asc" | "desc";

// ---------------------------------------------------------------------------
// Grade helpers
// ---------------------------------------------------------------------------

function scoreToGrade(
  avg: number
): "optimised" | "strong" | "needs_work" | "poor" | "critical" {
  if (avg >= 15) return "optimised";
  if (avg >= 13) return "strong";
  if (avg >= 10) return "needs_work";
  if (avg >= 6) return "poor";
  return "critical";
}

// ---------------------------------------------------------------------------
// getDashboardStats
// ---------------------------------------------------------------------------

export async function getDashboardStats(
  businessId: string
): Promise<DashboardStats> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Fetch all posts for this business (lightweight — no body columns)
  const rows = await db
    .select({
      id: posts.id,
      status: posts.status,
      auditStatus: posts.auditStatus,
      auditScore: posts.auditScore,
      auditGrade: posts.auditGrade,
      auditResults: posts.auditResults,
      cannibalizationFlag: posts.cannibalizationFlag,
    })
    .from(posts)
    .where(eq(posts.businessId, businessId));

  const totalPosts = rows.length;
  let publishedCount = 0;
  let scheduledCount = 0;
  let draftCount = 0;

  let optimisedCount = 0;
  let strongCount = 0;
  let needsWorkCount = 0;
  let poorCount = 0;
  let criticalCount = 0;
  let cannibalisationCount = 0;
  let auditedPostCount = 0;

  let scoreSum = 0;
  let poorCriticalScoreSum = 0;
  let poorAndCriticalCount = 0;

  for (const row of rows) {
    // Status counts
    if (row.status === "published") publishedCount++;
    else if (row.status === "scheduled") scheduledCount++;
    else draftCount++;

    // Cannibalisation
    if (row.cannibalizationFlag) cannibalisationCount++;

    // Grade counts (only for audited posts)
    if (row.auditStatus === "complete" && row.auditScore !== null && row.auditGrade !== null) {
      auditedPostCount++;
      scoreSum += row.auditScore;

      switch (row.auditGrade) {
        case "optimised": optimisedCount++; break;
        case "strong": strongCount++; break;
        case "needs_work": needsWorkCount++; break;
        case "poor":
          poorCount++;
          poorAndCriticalCount++;
          poorCriticalScoreSum += row.auditScore;
          break;
        case "critical":
          criticalCount++;
          poorAndCriticalCount++;
          poorCriticalScoreSum += row.auditScore;
          break;
      }
    }
  }

  // Health score = average audit score across all audited posts (0–16 scale)
  const healthScore =
    auditedPostCount > 0
      ? Math.round((scoreSum / auditedPostCount) * 10) / 10
      : null;

  const healthGrade = healthScore !== null ? scoreToGrade(healthScore) : null;

  // Score potential: average additional points if all Poor/Critical posts were
  // rewritten to 15/16 (the minimum Optimised threshold).
  let scorePotential: number | null = null;
  let projectedHealthScore: number | null = null;

  if (auditedPostCount > 0 && poorAndCriticalCount > 0) {
    // If we fix all poor/critical to 15, the new average becomes:
    // (scoreSum - poorCriticalScoreSum + poorAndCriticalCount * 15) / auditedPostCount
    const projectedSum =
      scoreSum - poorCriticalScoreSum + poorAndCriticalCount * 15;
    const projected = projectedSum / auditedPostCount;
    projectedHealthScore = Math.round(projected * 10) / 10;
    scorePotential = Math.round((projected - (scoreSum / auditedPostCount)) * 10) / 10;
  }

  const needsFirstAudit = totalPosts > 0 && auditedPostCount === 0;

  return {
    healthScore,
    healthGrade,
    scorePotential,
    poorAndCriticalCount,
    projectedHealthScore,
    totalPosts,
    publishedCount,
    scheduledCount,
    draftCount,
    optimisedCount,
    strongCount,
    needsWorkCount,
    poorCount,
    criticalCount,
    cannibalisationCount,
    auditedPostCount,
    needsFirstAudit,
  };
}

// ---------------------------------------------------------------------------
// getPostTableRows
// ---------------------------------------------------------------------------

export async function getPostTableRows(
  businessId: string,
  gradeFilter: GradeFilter = "all",
  statusFilter: StatusFilter = "all",
  sortField: SortField = "score",
  sortDir: SortDir = "asc"
): Promise<PostTableRow[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Build where conditions
  const conditions = [eq(posts.businessId, businessId)];
  if (statusFilter !== "all") {
    conditions.push(eq(posts.status, statusFilter));
  }
  if (gradeFilter !== "all") {
    conditions.push(eq(posts.auditGrade, gradeFilter));
  }

  const rows = await db
    .select({
      id: posts.id,
      title: posts.title,
      url: posts.url,
      focusKeyword: posts.focusKeyword,
      status: posts.status,
      auditStatus: posts.auditStatus,
      auditScore: posts.auditScore,
      auditGrade: posts.auditGrade,
      auditResults: posts.auditResults,
      cannibalizationFlag: posts.cannibalizationFlag,
      rewriteStatus: posts.rewriteStatus,
      publishDate: posts.publishDate,
      scheduledDate: posts.scheduledDate,
      authorNameCms: posts.authorNameCms,
      keywordSource: posts.keywordSource,
    })
    .from(posts)
    .where(and(...conditions));

  // Count issues from auditResults JSONB
  const mapped: PostTableRow[] = rows.map((row) => {
    let issueCount: number | null = null;
    if (row.auditResults && typeof row.auditResults === "object") {
      const results = row.auditResults as { points?: Array<{ pass: boolean }> };
      if (Array.isArray(results.points)) {
        issueCount = results.points.filter((p) => !p.pass).length;
      }
    }
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      focusKeyword: row.focusKeyword ?? null,
      status: row.status,
      auditStatus: row.auditStatus ?? null,
      auditScore: row.auditScore ?? null,
      auditGrade: row.auditGrade ?? null,
      issueCount,
      cannibalizationFlag: row.cannibalizationFlag,
      rewriteStatus: row.rewriteStatus ?? null,
      publishDate: row.publishDate ?? null,
      scheduledDate: row.scheduledDate ?? null,
      authorNameCms: row.authorNameCms,
      keywordSource: row.keywordSource ?? null,
    };
  });

  // Sort
  const gradeOrder: Record<string, number> = {
    critical: 0,
    poor: 1,
    needs_work: 2,
    strong: 3,
    optimised: 4,
  };

  mapped.sort((a, b) => {
    let cmp = 0;
    if (sortField === "score") {
      const aScore = a.auditScore ?? -1;
      const bScore = b.auditScore ?? -1;
      cmp = aScore - bScore;
    } else if (sortField === "grade") {
      const aGrade = gradeOrder[a.auditGrade ?? ""] ?? -1;
      const bGrade = gradeOrder[b.auditGrade ?? ""] ?? -1;
      cmp = aGrade - bGrade;
    } else {
      cmp = a.title.localeCompare(b.title);
    }
    return sortDir === "desc" ? -cmp : cmp;
  });

  return mapped;
}
