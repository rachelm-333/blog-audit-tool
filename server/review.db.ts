/**
 * iAudit — Review & Edit DB Helpers (Layer 8 / Section 12)
 *
 * Provides:
 *   getPostForReview      — fetch a post with all fields needed for the review screen
 *   saveApprovedContent   — persist body_approved, meta_title_rewritten, meta_description_rewritten,
 *                           body_image_alts, and optionally updated rewrite_score/grade after re-score
 *   setPostBackStatus     — mark post_back_status as pending/complete/failed
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { posts } from "../drizzle/schema";
import type { AuditResultsJson } from "./audit.db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface SaveApprovedInput {
  bodyApproved: string;
  metaTitleRewritten: string;
  metaDescriptionRewritten: string;
  bodyImageAlts: string[]; // ordered list matching <img> elements in body
  rewriteScore?: number;
  rewriteGrade?: "optimised" | "strong" | "needs_work" | "poor" | "critical";
  auditResults?: AuditResultsJson;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch a post with all fields needed for the review screen */
export async function getPostForReview(postId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      id: posts.id,
      businessId: posts.businessId,
      title: posts.title,
      bodyOriginal: posts.bodyOriginal,
      bodyRewritten: posts.bodyRewritten,
      bodyApproved: posts.bodyApproved,
      url: posts.url,
      status: posts.status,
      publishDate: posts.publishDate,
      scheduledDate: posts.scheduledDate,
      authorNameCms: posts.authorNameCms,
      focusKeyword: posts.focusKeyword,
      secondaryKeywords: posts.secondaryKeywords,
      metaTitleOriginal: posts.metaTitleOriginal,
      metaDescriptionOriginal: posts.metaDescriptionOriginal,
      metaTitleRewritten: posts.metaTitleRewritten,
      metaDescriptionRewritten: posts.metaDescriptionRewritten,
      auditScore: posts.auditScore,
      auditGrade: posts.auditGrade,
      auditResults: posts.auditResults,
      rewriteScore: posts.rewriteScore,
      rewriteGrade: posts.rewriteGrade,
      rewriteStatus: posts.rewriteStatus,
      schemaJson: posts.schemaJson,
      bodyImageAlts: posts.bodyImageAlts,
      postBackStatus: posts.postBackStatus,
      cannibalizationFlag: posts.cannibalizationFlag,
      paaQuestion: posts.paaQuestion,
      articleType: posts.articleType,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return rows[0] ?? null;
}

/** Persist the approved content (body, meta, alt texts) and optionally updated re-score */
export async function saveApprovedContent(
  postId: string,
  input: SaveApprovedInput
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const updateFields: Record<string, unknown> = {
    bodyApproved: input.bodyApproved,
    metaTitleRewritten: input.metaTitleRewritten,
    metaDescriptionRewritten: input.metaDescriptionRewritten,
    bodyImageAlts: input.bodyImageAlts as unknown as Record<string, unknown>,
  };

  if (input.rewriteScore !== undefined) {
    updateFields.rewriteScore = input.rewriteScore;
  }
  if (input.rewriteGrade !== undefined) {
    updateFields.rewriteGrade = input.rewriteGrade;
  }
  if (input.auditResults !== undefined) {
    updateFields.auditResults = input.auditResults as unknown as Record<
      string,
      unknown
    >;
  }

  await db.update(posts).set(updateFields).where(eq(posts.id, postId));
}

/** Set post_back_status to pending/complete/failed */
export async function setPostBackStatus(
  postId: string,
  status: "pending" | "complete" | "failed"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(posts)
    .set({
      postBackStatus: status,
      ...(status === "complete" ? { postBackAt: new Date() } : {}),
    })
    .where(eq(posts.id, postId));
}
