/**
 * iAudit — Keyword DB Helpers (Layer 5)
 *
 * Provides database operations for keyword identification:
 * - updatePostKeyword: set focus_keyword + keyword_source on a post
 * - saveKeyword: set focus_keyword + secondary_keywords + source, optionally clear audit
 * - listPostsForBusiness: return id + focusKeyword for all posts in a business
 * - updateCannibalisationFlags: bulk-update cannibalization_flag
 * - getPostForKeyword: fetch post fields needed for keyword management
 */

import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { posts } from "../drizzle/schema";

// ---------------------------------------------------------------------------
// updatePostKeyword — legacy helper (used by keyword.confirm)
// ---------------------------------------------------------------------------

export async function updatePostKeyword(
  postId: string,
  keyword: string,
  source: "cms_scraped" | "user_entered"
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(posts)
    .set({
      focusKeyword: keyword,
      keywordSource: source,
      updatedAt: new Date(),
    })
    .where(eq(posts.id, postId));
}

// ---------------------------------------------------------------------------
// saveKeyword — save primary + secondary keywords, optionally clear audit
// ---------------------------------------------------------------------------

export async function saveKeyword(
  postId: string,
  focusKeyword: string,
  secondaryKeywords: string[],
  source: "cms_scraped" | "user_entered",
  clearAudit: boolean
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  if (clearAudit) {
    await db
      .update(posts)
      .set({
        focusKeyword,
        secondaryKeywords,
        keywordSource: source,
        auditScore: null,
        auditGrade: null,
        auditResults: null,
        auditStatus: null,
        auditedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, postId));
  } else {
    await db
      .update(posts)
      .set({
        focusKeyword,
        secondaryKeywords,
        keywordSource: source,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, postId));
  }
}

// ---------------------------------------------------------------------------
// listPostsForBusiness
// ---------------------------------------------------------------------------

export async function listPostsForBusiness(businessId: string): Promise<
  Array<{
    id: string;
    focusKeyword: string | null;
    secondaryKeywords: unknown;
    title: string;
    url: string;
    cannibalizationFlag: boolean;
    keywordSource: string | null;
    auditStatus: string | null;
    auditScore: number | null;
    auditGrade: string | null;
    rewriteStatus: string | null;
    rewriteScore: number | null;
    rewriteGrade: string | null;
  }>
> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      id: posts.id,
      focusKeyword: posts.focusKeyword,
      secondaryKeywords: posts.secondaryKeywords,
      title: posts.title,
      url: posts.url,
      cannibalizationFlag: posts.cannibalizationFlag,
      keywordSource: posts.keywordSource,
      auditStatus: posts.auditStatus,
      auditScore: posts.auditScore,
      auditGrade: posts.auditGrade,
      rewriteStatus: posts.rewriteStatus,
      rewriteScore: posts.rewriteScore,
      rewriteGrade: posts.rewriteGrade,
    })
    .from(posts)
    .where(eq(posts.businessId, businessId));

  return rows;
}

// ---------------------------------------------------------------------------
// updateCannibalisationFlags
// ---------------------------------------------------------------------------

/**
 * Bulk-update cannibalization_flag:
 * - flaggedPostIds → set cannibalization_flag = true
 * - unflaggedPostIds → set cannibalization_flag = false
 * Both arrays can be empty (no-op for that side).
 */
export async function updateCannibalisationFlags(
  flaggedPostIds: string[],
  unflaggedPostIds: string[]
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  if (flaggedPostIds.length > 0) {
    await db
      .update(posts)
      .set({ cannibalizationFlag: true, updatedAt: new Date() })
      .where(inArray(posts.id, flaggedPostIds));
  }

  if (unflaggedPostIds.length > 0) {
    await db
      .update(posts)
      .set({ cannibalizationFlag: false, updatedAt: new Date() })
      .where(inArray(posts.id, unflaggedPostIds));
  }
}

// ---------------------------------------------------------------------------
// getPostForKeyword — for keyword management tRPC procedures
// ---------------------------------------------------------------------------

export async function getPostForKeyword(postId: string): Promise<{
  id: string;
  title: string;
  bodyOriginal: string;
  focusKeyword: string | null;
  secondaryKeywords: unknown;
  keywordSource: string | null;
  businessId: string;
  auditScore: number | null;
  metaTitleOriginal: string | null;
  metaDescriptionOriginal: string | null;
} | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      id: posts.id,
      title: posts.title,
      bodyOriginal: posts.bodyOriginal,
      focusKeyword: posts.focusKeyword,
      secondaryKeywords: posts.secondaryKeywords,
      keywordSource: posts.keywordSource,
      businessId: posts.businessId,
      auditScore: posts.auditScore,
      metaTitleOriginal: posts.metaTitleOriginal,
      metaDescriptionOriginal: posts.metaDescriptionOriginal,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  return rows[0] ?? null;
}
