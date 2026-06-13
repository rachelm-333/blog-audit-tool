/**
 * CMS connections and posts database helpers for Layer 4.
 *
 * All credential reads/writes go through the encryption service.
 * Plain text credentials are NEVER written to the database.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { decryptCredentials, encryptCredentials } from "./encryption.service";
import type { CmsCredentials } from "./encryption.service";
import { cmsConnections, posts } from "../drizzle/schema";
import type { InsertPost, Post } from "../drizzle/schema";
import type { WpImportedPost } from "./wordpress.service";

// ─── CMS Connections ──────────────────────────────────────────────────────────

export interface CreateConnectionInput {
  businessId: string;
  platform: "wordpress" | "wix" | "shopify" | "webflow" | "zapier";
  siteUrl: string;
  credentials: CmsCredentials;
}

export async function createCmsConnection(input: CreateConnectionInput) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const id = nanoid(21);
  const encryptedCreds = encryptCredentials(input.credentials as unknown as Record<string, string>);

  await db.insert(cmsConnections).values({
    id,
    businessId: input.businessId,
    platform: input.platform,
    siteUrl: input.siteUrl,
    credentialsEncrypted: encryptedCreds,
    connectionStatus: "connected",
    lastSyncAt: new Date(),
  });

  return id;
}

export async function getCmsConnectionById(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select()
    .from(cmsConnections)
    .where(eq(cmsConnections.id, id))
    .limit(1);

  return rows[0] ?? null;
}

export async function getCmsConnectionsByBusinessId(businessId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db
    .select()
    .from(cmsConnections)
    .where(eq(cmsConnections.businessId, businessId));
}

export async function updateCmsConnectionStatus(
  id: string,
  status: "connected" | "disconnected" | "error",
  lastSyncAt?: Date
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(cmsConnections)
    .set({
      connectionStatus: status,
      ...(lastSyncAt ? { lastSyncAt } : {}),
    })
    .where(eq(cmsConnections.id, id));
}

export async function deleteCmsConnection(id: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(cmsConnections).where(eq(cmsConnections.id, id));
}

/**
 * Decrypts and returns the credentials for a connection.
 * NEVER expose this to the client — server-side only.
 */
export function decryptConnectionCredentials(
  connection: { credentialsEncrypted: unknown }
): Record<string, string> {
  const encrypted =
    typeof connection.credentialsEncrypted === "string"
      ? connection.credentialsEncrypted
      : JSON.stringify(connection.credentialsEncrypted);
  return decryptCredentials(encrypted);
}

// ─── Posts ────────────────────────────────────────────────────────────────────

export interface UpsertPostInput extends WpImportedPost {
  businessId: string;
  cmsPlatform: "wordpress" | "wix" | "shopify" | "webflow" | "zapier";
}

/**
 * Upserts a post by (businessId, cmsPostId, cmsPlatform).
 * If the post already exists, only non-destructive fields are updated.
 * The original body is NEVER overwritten after initial import.
 */
export async function upsertPost(input: UpsertPostInput): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check if post already exists
  const existing = await db
    .select({ id: posts.id, bodyOriginal: posts.bodyOriginal })
    .from(posts)
    .where(
      and(
        eq(posts.businessId, input.businessId),
        eq(posts.cmsPostId, input.cmsPostId),
        eq(posts.cmsPlatform, input.cmsPlatform)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    // Update metadata but NEVER overwrite bodyOriginal
    await db
      .update(posts)
      .set({
        title: input.title,
        url: input.url,
        status: input.status,
        publishDate: input.publishDate ?? undefined,
        scheduledDate: input.scheduledDate ?? undefined,
        authorIdCms: input.authorIdCms,
        authorNameCms: input.authorNameCms,
        focusKeyword: input.focusKeyword ?? undefined,
        keywordSource: input.focusKeyword ? "cms_scraped" : undefined,
        // Use || so empty/null values don't overwrite existing data; fall back to title for meta title
        metaTitleOriginal: input.metaTitle || input.title || undefined,
        metaDescriptionOriginal: input.metaDescription || undefined,
        featuredImageUrl: input.featuredImageUrl || undefined,
        featuredImageAlt: input.featuredImageAlt || undefined,
        bodyImageAlts: input.bodyImageAlts.length > 0 ? input.bodyImageAlts : undefined,
        categories: input.categories.length > 0 ? input.categories : undefined,
        tags: input.tags.length > 0 ? input.tags : undefined,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, existing[0]!.id));

    return existing[0]!.id;
  }

  // New post — insert with original body
  const id = nanoid(21);
  await db.insert(posts).values({
    id,
    businessId: input.businessId,
    cmsPostId: input.cmsPostId,
    cmsPlatform: input.cmsPlatform,
    title: input.title,
    bodyOriginal: input.bodyHtml,
    url: input.url,
    status: input.status,
    publishDate: input.publishDate ?? undefined,
    scheduledDate: input.scheduledDate ?? undefined,
    authorIdCms: input.authorIdCms,
    authorNameCms: input.authorNameCms,
    focusKeyword: input.focusKeyword ?? undefined,
    keywordSource: input.focusKeyword ? "cms_scraped" : undefined,
    // Fall back to post title when Wix doesn't provide a custom SEO meta title
    metaTitleOriginal: input.metaTitle || input.title || undefined,
    metaDescriptionOriginal: input.metaDescription || undefined,
    featuredImageUrl: input.featuredImageUrl || undefined,
    featuredImageAlt: input.featuredImageAlt || undefined,
    bodyImageAlts: input.bodyImageAlts.length > 0 ? input.bodyImageAlts : undefined,
    categories: input.categories.length > 0 ? input.categories : undefined,
    tags: input.tags.length > 0 ? input.tags : undefined,
    cannibalizationFlag: false,
  });

  return id;
}

export async function getPostsByBusinessId(
  businessId: string,
  statusFilter?: "published" | "scheduled" | "draft"
): Promise<Post[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [eq(posts.businessId, businessId)];
  if (statusFilter) {
    conditions.push(eq(posts.status, statusFilter));
  }

  return db
    .select()
    .from(posts)
    .where(and(...conditions));
}

export async function getPostById(id: string): Promise<Post | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function countPostsByBusiness(businessId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select({
      status: posts.status,
      count: sql<number>`COUNT(*)`,
    })
    .from(posts)
    .where(eq(posts.businessId, businessId))
    .groupBy(posts.status);

  return result.reduce(
    (acc, row) => {
      acc[row.status] = Number(row.count);
      return acc;
    },
    { published: 0, scheduled: 0, draft: 0 } as Record<string, number>
  );
}
