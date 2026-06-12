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
import {
  testWixConnection,
  importWixPosts,
  WixImportException,
} from "../wix.service";
import {
  testShopifyConnection,
  importShopifyPosts,
  ShopifyImportException,
} from "../shopify.service";
import { generateZapierToken } from "../zapier.service";
import type { WordPressCredentials, WixCredentials, ShopifyCredentials, ZapierCredentials } from "../encryption.service";
import { encryptCredentials } from "../encryption.service";
import { nanoid } from "nanoid";
import { extractKeywordFromTitle } from "../keyword.service";
import { saveKeyword, getPostForKeyword } from "../keyword.db";

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

// ─── Error mapping helpers ───────────────────────────────────────────────────

function mapWixError(err: WixImportException): TRPCError {
  const messages: Record<string, string> = {
    invalid_credentials: "We could not connect to your Wix site. Please check your Site ID and API key.",
    insufficient_permissions: "Your Wix API key does not have permission to read blog posts. Please check your Wix permissions.",
    site_unreachable: "We could not reach the Wix API. Please try again.",
    rate_limit: "Import paused — too many requests. We will continue automatically in 60 seconds.",
    zero_posts: "No blog posts were found on your Wix site.",
  };
  return new TRPCError({
    code: err.code === "insufficient_permissions" ? "FORBIDDEN" : "BAD_REQUEST",
    message: messages[err.code] ?? err.message,
    cause: err,
  });
}

function mapShopifyError(err: ShopifyImportException): TRPCError {
  const messages: Record<string, string> = {
    invalid_credentials: "We could not connect to your Shopify store. Please check your store URL and access token.",
    insufficient_permissions: "Your Shopify access token does not have permission to read blog posts. Please check your Shopify API scopes.",
    site_unreachable: "We could not reach your Shopify store. Please check it is online and try again.",
    rate_limit: "Import paused — too many requests. We will continue automatically in 60 seconds.",
    zero_posts: "No blog articles were found on your Shopify store.",
    no_blogs: "No blogs were found on your Shopify store. Please create a blog first.",
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
   * Connect a Wix site.
   */
  connectWix: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
        siteId: z.string().min(1, "Site ID is required."),
        apiKey: z.string().min(1, "API key is required."),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const creds: WixCredentials = { siteId: input.siteId, apiKey: input.apiKey };

      let displayName: string;
      {
        const result = await testWixConnection(creds);
        if (!result.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
        }
        displayName = result.siteId;
      }

      const existing = await getCmsConnectionsByBusinessId(input.businessId);
      const existingWix = existing.find((c) => c.platform === "wix");

      if (existingWix) {
        const db = (await import("../db")).getDb();
        const { cmsConnections } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const dbInstance = await db;
        if (dbInstance) {
          await dbInstance.update(cmsConnections).set({
            siteUrl: `https://www.wix.com/site/${input.siteId}`,
            credentialsEncrypted: encryptCredentials(creds as unknown as Record<string, string>),
            connectionStatus: "connected",
            lastSyncAt: new Date(),
          }).where(eq(cmsConnections.id, existingWix.id));
        }
        return { connectionId: existingWix.id, displayName, reconnected: true };
      }

      const connectionId = await createCmsConnection({
        businessId: input.businessId,
        platform: "wix",
        siteUrl: `https://www.wix.com/site/${input.siteId}`,
        credentials: creds,
      });
      return { connectionId, displayName, reconnected: false };
    }),

  /**
   * Connect a Shopify store.
   */
  connectShopify: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
        shop: z.string().min(1, "Store URL is required."),
        accessToken: z.string().min(1, "Access token is required."),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const creds: ShopifyCredentials = { shop: input.shop, accessToken: input.accessToken };

      let displayName: string;
      {
        const result = await testShopifyConnection(creds);
        if (!result.ok) {
          throw new TRPCError({ code: "BAD_REQUEST", message: result.message });
        }
        displayName = result.shop;
      }

      const existing = await getCmsConnectionsByBusinessId(input.businessId);
      const existingShopify = existing.find((c) => c.platform === "shopify");

      if (existingShopify) {
        const db = (await import("../db")).getDb();
        const { cmsConnections } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const dbInstance = await db;
        if (dbInstance) {
          await dbInstance.update(cmsConnections).set({
            siteUrl: `https://${input.shop}`,
            credentialsEncrypted: encryptCredentials(creds as unknown as Record<string, string>),
            connectionStatus: "connected",
            lastSyncAt: new Date(),
          }).where(eq(cmsConnections.id, existingShopify.id));
        }
        return { connectionId: existingShopify.id, displayName, reconnected: true };
      }

      const connectionId = await createCmsConnection({
        businessId: input.businessId,
        platform: "shopify",
        siteUrl: `https://${input.shop}`,
        credentials: creds,
      });
      return { connectionId, displayName, reconnected: false };
    }),

  /**
   * Connect via Zapier (generates inbound webhook token).
   */
  connectZapier: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
        outboundWebhookUrl: z.string().url().optional(),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const webhookSecret = generateZapierToken();
      const creds: ZapierCredentials = {
        webhookSecret,
        outboundWebhookUrl: input.outboundWebhookUrl,
      };

      const existing = await getCmsConnectionsByBusinessId(input.businessId);
      const existingZapier = existing.find((c) => c.platform === "zapier");

      let connectionId: string;
      if (existingZapier) {
        const db = (await import("../db")).getDb();
        const { cmsConnections } = await import("../../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        const dbInstance = await db;
        if (dbInstance) {
          await dbInstance.update(cmsConnections).set({
            credentialsEncrypted: encryptCredentials(creds as unknown as Record<string, string>),
            connectionStatus: "connected",
            lastSyncAt: new Date(),
          }).where(eq(cmsConnections.id, existingZapier.id));
        }
        connectionId = existingZapier.id;
      } else {
        connectionId = await createCmsConnection({
          businessId: input.businessId,
          platform: "zapier",
          siteUrl: "https://zapier.com",
          credentials: creds,
        });
      }

      // Return the inbound webhook URL for the user to configure in Zapier
      return {
        connectionId,
        webhookSecret,
        inboundUrl: `/api/zapier/inbound/${webhookSecret}`,
        reconnected: !!existingZapier,
      };
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

      const rawCreds = decryptConnectionCredentials(connection);

      try {
        if (connection.platform === "wordpress") {
          const creds: WordPressCredentials = {
            siteUrl: rawCreds["siteUrl"] ?? "",
            username: rawCreds["username"] ?? "",
            applicationPassword: rawCreds["applicationPassword"] ?? "",
          };
          const result = await testWordPressConnection(creds);
          await updateCmsConnectionStatus(connection.id, "connected", new Date());
          return { success: true, displayName: result.displayName };
        } else if (connection.platform === "wix") {
          const creds: WixCredentials = { siteId: rawCreds["siteId"] ?? "", apiKey: rawCreds["apiKey"] ?? "" };
          const wixResult = await testWixConnection(creds);
          if (!wixResult.ok) {
            await updateCmsConnectionStatus(connection.id, "error");
            throw new TRPCError({ code: "BAD_REQUEST", message: wixResult.message });
          }
          await updateCmsConnectionStatus(connection.id, "connected", new Date());
          return { success: true, displayName: wixResult.siteId };
        } else if (connection.platform === "shopify") {
          const creds: ShopifyCredentials = { shop: rawCreds["shop"] ?? "", accessToken: rawCreds["accessToken"] ?? "" };
          const shopifyResult = await testShopifyConnection(creds);
          if (!shopifyResult.ok) {
            await updateCmsConnectionStatus(connection.id, "error");
            throw new TRPCError({ code: "BAD_REQUEST", message: shopifyResult.message });
          }
          await updateCmsConnectionStatus(connection.id, "connected", new Date());
          return { success: true, displayName: shopifyResult.shop };
        } else {
          // Zapier — no active test possible
          return { success: true, displayName: "Zapier Webhook" };
        }
      } catch (err) {
        // Only mark as error for auth failures, not transient network errors
        const isAuthFailure =
          (err instanceof WpImportException && err.code === "invalid_credentials") ||
          (err instanceof WixImportException && err.code === "invalid_credentials") ||
          (err instanceof ShopifyImportException && err.code === "invalid_credentials");
        if (isAuthFailure) {
          await updateCmsConnectionStatus(connection.id, "error");
        }
        if (err instanceof WpImportException) throw mapWpError(err);
        if (err instanceof WixImportException) throw mapWixError(err);
        if (err instanceof ShopifyImportException) throw mapShopifyError(err);
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Connection test failed." });
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

      const rawCreds = decryptConnectionCredentials(connection);
      let importResult: { posts: any[]; errors: string[] };

      try {
        if (connection.platform === "wordpress") {
          const creds: WordPressCredentials = {
            siteUrl: rawCreds["siteUrl"] ?? "",
            username: rawCreds["username"] ?? "",
            applicationPassword: rawCreds["applicationPassword"] ?? "",
          };
          importResult = await importWordPressPosts(creds, { statusFilter: input.statusFilter });
        } else if (connection.platform === "wix") {
          const creds: WixCredentials = {
            siteId: rawCreds["siteId"] ?? "",
            apiKey: rawCreds["apiKey"] ?? "",
          };
          importResult = await importWixPosts(creds, input.statusFilter);
        } else if (connection.platform === "shopify") {
          const creds: ShopifyCredentials = {
            shop: rawCreds["shop"] ?? rawCreds["shopDomain"] ?? "",
            accessToken: rawCreds["accessToken"] ?? "",
          };
          importResult = await importShopifyPosts(creds);
        } else {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Post import is not yet supported for ${connection.platform} connections.`,
          });
        }
      } catch (err) {
        // Only mark as error for credential/auth failures — not for transient import errors
        const isAuthFailure =
          (err instanceof WpImportException && err.code === "invalid_credentials") ||
          (err instanceof WixImportException && err.code === "invalid_credentials") ||
          (err instanceof ShopifyImportException && err.code === "invalid_credentials");
        if (isAuthFailure) {
          await updateCmsConnectionStatus(connection.id, "error");
        }
        if (err instanceof WpImportException) throw mapWpError(err);
        if (err instanceof WixImportException) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        if (err instanceof ShopifyImportException) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred during import.",
        });
      }

      // Upsert all imported posts
      const upsertedIds: string[] = [];
      const upsertErrors: string[] = [];
      const platform = connection.platform as "wordpress" | "wix" | "shopify" | "zapier";

      for (const post of importResult.posts) {
        try {
          const id = await upsertPost({
            ...post,
            businessId: connection.businessId,
            cmsPlatform: platform,
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
        const s = post.status as "published" | "scheduled" | "draft";
        if (s in counts) counts[s] = (counts[s] ?? 0) + 1;
      }

      // Auto-detect focus keywords for newly imported posts that don't have one yet.
      // Runs in the background — does not block the import response.
      let keywordsAutoDetected = 0;
      for (const postId of upsertedIds) {
        try {
          const fullPost = await getPostForKeyword(postId);
          if (!fullPost || fullPost.focusKeyword) continue; // already has keyword
          const keyword = extractKeywordFromTitle(
            fullPost.title,
            fullPost.bodyOriginal ?? "",
            fullPost.metaTitleOriginal ?? "",
            fullPost.metaDescriptionOriginal ?? ""
          );
          if (keyword) {
            await saveKeyword(postId, keyword, [], "auto_detected", false);
            keywordsAutoDetected++;
          }
        } catch {
          // skip silently — keyword auto-detection is best-effort
        }
      }
      return {
        totalImported: upsertedIds.length,
        keywordsAutoDetected,
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
