/**
 * iAudit — Post Back DB Helpers (Layer 9 / Section 13)
 *
 * Provides:
 *   getPostForPostBack   — fetch all fields needed to perform a post-back
 *   setPostBackComplete  — mark post_back_status = 'complete', stamp post_back_at
 *   setPostBackFailed    — mark post_back_status = 'failed'
 */

import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { posts } from "../drizzle/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostForPostBack {
  id: string;
  businessId: string;
  cmsPostId: string;
  cmsPlatform: "wordpress" | "wix" | "shopify" | "zapier";
  title: string;
  bodyApproved: string | null;
  url: string;
  status: "published" | "scheduled" | "draft";
  authorIdCms: string;
  authorNameCms: string;
  metaTitleRewritten: string | null;
  metaDescriptionRewritten: string | null;
  bodyImageAlts: unknown; // JSON array of strings
  schemaJson: unknown; // JSON-LD schema from Layer 7
  rewriteScore: number | null;
  rewriteGrade: string | null;
  postBackStatus: "pending" | "complete" | "failed" | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all fields needed to perform a post-back.
 * Returns null if the post does not exist.
 */
export async function getPostForPostBack(postId: string): Promise<PostForPostBack | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({
      id: posts.id,
      businessId: posts.businessId,
      cmsPostId: posts.cmsPostId,
      cmsPlatform: posts.cmsPlatform,
      title: posts.title,
      bodyApproved: posts.bodyApproved,
      url: posts.url,
      status: posts.status,
      authorIdCms: posts.authorIdCms,
      authorNameCms: posts.authorNameCms,
      metaTitleRewritten: posts.metaTitleRewritten,
      metaDescriptionRewritten: posts.metaDescriptionRewritten,
      bodyImageAlts: posts.bodyImageAlts,
      schemaJson: posts.schemaJson,
      rewriteScore: posts.rewriteScore,
      rewriteGrade: posts.rewriteGrade,
      postBackStatus: posts.postBackStatus,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  return (rows[0] as PostForPostBack | undefined) ?? null;
}

/**
 * Mark a post as successfully posted back.
 * Sets post_back_status = 'complete' and stamps post_back_at with the current time.
 */
export async function setPostBackComplete(postId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(posts)
    .set({
      postBackStatus: "complete",
      postBackAt: new Date(),
    })
    .where(eq(posts.id, postId));
}

/**
 * Mark a post as having failed post-back.
 * Sets post_back_status = 'failed'.
 */
export async function setPostBackFailed(postId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(posts)
    .set({
      postBackStatus: "failed",
    })
    .where(eq(posts.id, postId));
}
