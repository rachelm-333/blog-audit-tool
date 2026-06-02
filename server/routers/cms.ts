/**
 * CMS connection and post import tRPC router — Layer 4.
 *
 * Procedures:
 *   cms.connect          — Validate credentials, save encrypted connection to DB
 *   cms.testConnection   — Test an existing connection (re-validate credentials)
 *   cms.importPosts      — Import posts from connected CMS (WordPress only in Layer 4)
 *   cms.getConnection    — Get a single connection by ID
 *   cms.listConnections  — List all connections for a business
 *   cms.disconnect       — Remove a CMS connection
 *   cms.getPostCounts    — Get post counts by status for a business
 *
 * Auth: publicProcedure + manual iauditUserId ownership validation (same pattern as business.ts).
 * Credentials: ALWAYS encrypted before DB write; NEVER returned to client.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import {
  createCmsConnection,
  deleteCmsConnection,
  decryptConnectionCredentials,
  getCmsConnectionById,
  getCmsConnectionsByBusinessId,
  updateCmsConnectionStatus,
  upsertPost,
  getPostsByBusinessId,
  countPostsByBusiness,
} from "../cms.db";
import { getBusinessById } from "../businesses.db";
import {
  testWordPressConnection,
  importWordPressPosts,
  WpImportException,
} from "../wordpress.service";
import type { WordPressCredentials } from "../encryption.service";
import { nanoid } from "nanoid";

// ─── Ownership guard ──────────────────────────────────────────────────────────

async function assertBusinessOwnership(businessId: string, iauditUserId: string) {
  const business = await getBusinessById(businessId);
  if (!business) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Business not found." });
  }
  if (business.userId !== iauditUserId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this business." });
  }
  return business;
}

async function assertConnectionOwnership(connectionId: string, iauditUserId: string) {
  const connection = await getCmsConnectionById(connectionId);
  if (!connection) {
    throw new TRPCError({ code: "NOT_FOUND", message: "CMS connection not found." });
  }
  await assertBusinessOwnership(connection.businessId, iauditUserId);
  return connection;
}

// ─── Error mapping ────────────────────────────────────────────────────────────

function mapWpError(err: WpImportException): TRPCError {
  const messages: Record<string, string> = {
    invalid_credentials:
      "We could not connect to your WordPress site. Please check your URL, username, and application password.",
    insufficient_permissions:
      "Your WordPress user does not have permission to read or edit posts. Please use an Administrator account.",
    site_unreachable:
      "We could not reach your website. Please check it is online and try again.",
    rate_limit:
      "Import paused — too many requests. We will continue automatically in 60 seconds.",
    zero_posts:
      "No posts were found with the selected status. Try selecting All post types.",
    not_wordpress:
      "The URL does not appear to be a WordPress site, or the REST API is disabled.",
  };

  return new TRPCError({
    code: err.code === "insufficient_permissions" ? "FORBIDDEN" : "BAD_REQUEST",
    message: messages[err.code] ?? err.message,
    cause: err,
  });
}

// ─── Input schemas ────────────────────────────────────────────────────────────

const wordpressConnectionSchema = z.object({
  iauditUserId: z.string().min(1),
  businessId: z.string().min(1),
  siteUrl: z.string().url("Please enter a valid WordPress site URL."),
  username: z.string().min(1, "Username is required."),
  applicationPassword: z.string().min(1, "Application password is required."),
});

const importPostsSchema = z.object({
  iauditUserId: z.string().min(1),
  connectionId: z.string().min(1),
  statusFilter: z.enum(["published", "scheduled", "draft", "all"]).default("all"),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const cmsRouter = router({
  /**
   * Connect a WordPress site.
   * Validates credentials via WP REST API before saving to DB.
   * Credentials are encrypted at rest — never stored plain text.
   */
  connect: publicProcedure
    .input(wordpressConnectionSchema)
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const creds: WordPressCredentials = {
        siteUrl: input.siteUrl,
        username: input.username,
        applicationPassword: input.applicationPassword,
      };

      // Validate credentials before saving
      let displayName: string;
      try {
        const result = await testWordPressConnection(creds);
        displayName = result.displayName;
      } catch (err) {
        if (err instanceof WpImportException) throw mapWpError(err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred while connecting to WordPress.",
        });
      }

      // Check if a connection already exists for this business + platform
      const existing = await getCmsConnectionsByBusinessId(input.businessId);
      const existingWp = existing.find((c) => c.platform === "wordpress");

      if (existingWp) {
        // Update existing connection with new credentials
        const db = (await import("../db")).getDb();
        const { cmsConnections } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const { encryptCredentials } = await import("../encryption.service");
        const dbInstance = await db;
        if (dbInstance) {
          await dbInstance
            .update(cmsConnections)
            .set({
              siteUrl: input.siteUrl,
              credentialsEncrypted: encryptCredentials(creds as unknown as Record<string, string>),
              connectionStatus: "connected",
              lastSyncAt: new Date(),
            })
            .where(eq(cmsConnections.id, existingWp.id));
        }
        return { connectionId: existingWp.id, displayName, reconnected: true };
      }

      const connectionId = await createCmsConnection({
        businessId: input.businessId,
        platform: "wordpress",
        siteUrl: input.siteUrl,
        credentials: creds,
      });

      return { connectionId, displayName, reconnected: false };
    }),

  /**
   * Test an existing connection by re-validating credentials.
   */
  testConnection: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        connectionId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const connection = await assertConnectionOwnership(input.connectionId, input.iauditUserId);

      if (connection.platform !== "wordpress") {
        return { success: true, message: "Connection test not available for this platform yet." };
      }

      const rawCreds = decryptConnectionCredentials(connection);
      const creds: WordPressCredentials = {
        siteUrl: rawCreds["siteUrl"] ?? "",
        username: rawCreds["username"] ?? "",
        applicationPassword: rawCreds["applicationPassword"] ?? "",
      };

      try {
        const result = await testWordPressConnection(creds);
        await updateCmsConnectionStatus(connection.id, "connected", new Date());
        return { success: true, displayName: result.displayName };
      } catch (err) {
        await updateCmsConnectionStatus(connection.id, "error");
        if (err instanceof WpImportException) throw mapWpError(err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Connection test failed.",
        });
      }
    }),

  /**
   * Import posts from a connected WordPress site.
   * Status filter: published / scheduled / draft / all.
   * Trash posts are NEVER imported regardless of filter.
   * Upserts by (businessId, cmsPostId, cmsPlatform) — safe to re-run.
   */
  importPosts: publicProcedure
    .input(importPostsSchema)
    .mutation(async ({ input }) => {
      const connection = await assertConnectionOwnership(input.connectionId, input.iauditUserId);

      if (connection.platform !== "wordpress") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Post import is only available for WordPress connections in this version.",
        });
      }

      const rawCreds = decryptConnectionCredentials(connection);
      const creds: WordPressCredentials = {
        siteUrl: rawCreds["siteUrl"] ?? "",
        username: rawCreds["username"] ?? "",
        applicationPassword: rawCreds["applicationPassword"] ?? "",
      };

      let importResult;
      try {
        importResult = await importWordPressPosts(creds, {
          statusFilter: input.statusFilter,
        });
      } catch (err) {
        await updateCmsConnectionStatus(connection.id, "error");
        if (err instanceof WpImportException) throw mapWpError(err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred during import.",
        });
      }

      // Upsert all imported posts
      const upsertedIds: string[] = [];
      const upsertErrors: string[] = [];

      for (const post of importResult.posts) {
        try {
          const id = await upsertPost({
            ...post,
            businessId: connection.businessId,
            cmsPlatform: "wordpress",
          });
          upsertedIds.push(id);
        } catch (err: any) {
          upsertErrors.push(`Post ${post.cmsPostId}: ${err?.message ?? "DB error"}`);
        }
      }

      // Update last sync timestamp
      await updateCmsConnectionStatus(connection.id, "connected", new Date());

      // Count by status
      const counts = { published: 0, scheduled: 0, draft: 0 };
      for (const post of importResult.posts) {
        counts[post.status] = (counts[post.status] ?? 0) + 1;
      }

      return {
        totalImported: upsertedIds.length,
        counts,
        errors: [...importResult.errors, ...upsertErrors],
      };
    }),

  /**
   * Get a single CMS connection (without credentials).
   */
  getConnection: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        connectionId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const connection = await assertConnectionOwnership(input.connectionId, input.iauditUserId);
      // NEVER return credentials to the client
      const { credentialsEncrypted: _creds, ...safe } = connection;
      return safe;
    }),

  /**
   * List all CMS connections for a business (without credentials).
   */
  listConnections: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);
      const connections = await getCmsConnectionsByBusinessId(input.businessId);
      // Strip credentials from all connections
      return connections.map(({ credentialsEncrypted: _creds, ...safe }) => safe);
    }),

  /**
   * Disconnect (delete) a CMS connection.
   */
  disconnect: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        connectionId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      await assertConnectionOwnership(input.connectionId, input.iauditUserId);
      await deleteCmsConnection(input.connectionId);
      return { success: true };
    }),

  /**
   * Get post counts by status for a business.
   */
  getPostCounts: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);
      return countPostsByBusiness(input.businessId);
    }),

  /**
   * List posts for a business (lightweight — no body content).
   */
  listPosts: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
        statusFilter: z.enum(["published", "scheduled", "draft"]).optional(),
      })
    )
    .query(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);
      const allPosts = await getPostsByBusinessId(input.businessId, input.statusFilter);
      // Return lightweight list — omit body content for performance
      return allPosts.map((p) => ({
        id: p.id,
        cmsPostId: p.cmsPostId,
        cmsPlatform: p.cmsPlatform,
        title: p.title,
        url: p.url,
        status: p.status,
        publishDate: p.publishDate,
        scheduledDate: p.scheduledDate,
        authorNameCms: p.authorNameCms,
        focusKeyword: p.focusKeyword,
        auditScore: p.auditScore,
        auditGrade: p.auditGrade,
        cannibalizationFlag: p.cannibalizationFlag,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }));
    }),
});
