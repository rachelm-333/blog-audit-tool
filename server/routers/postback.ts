/**
 * iAudit — Post Back to CMS tRPC Router (Layer 9 / Section 13 + 16.1)
 *
 * Procedures:
 *   postback.runPostBack       — Write approved content back to the CMS
 *   postback.getPostBackStatus — Get current post_back_status for a post
 *
 * Auth: publicProcedure + manual iauditUserId ownership validation.
 *
 * Error states (Table 20 / Section 13.3):
 *   1. CMS connection lost → prompt reconnection before attempting write
 *   2. Post no longer exists in CMS → offer export instead
 *   3. Insufficient write permissions → show credentials error with instructions
 *   4. Partial failure → content written but meta could not be updated
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getBusinessById } from "../businesses.db";
import {
  getCmsConnectionsByBusinessId,
  decryptConnectionCredentials,
  updateCmsConnectionStatus,
} from "../cms.db";
import {
  getPostForPostBack,
  setPostBackComplete,
  setPostBackFailed,
} from "../postback.db";
import {
  postBackToWordPress,
  PostBackException,
} from "../postback.service";
import { postBackToWix } from "../wix.service";
import { postBackToShopify } from "../shopify.service";
import { postBackViaZapier } from "../zapier.service";
import { getCreditsRemaining } from "../rewrite.db";
import type { WordPressCredentials, WixCredentials, ShopifyCredentials, ZapierCredentials } from "../encryption.service";

// ---------------------------------------------------------------------------
// Ownership helpers
// ---------------------------------------------------------------------------

async function assertPostOwnership(postId: string, iauditUserId: string) {
  const post = await getPostForPostBack(postId);
  if (!post) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Post not found." });
  }
  const business = await getBusinessById(post.businessId);
  if (!business || business.userId !== iauditUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to this post.",
    });
  }
  return { post, business };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const postbackRouter = router({
  /**
   * postback.runPostBack
   *
   * Writes the approved content back to the exact CMS post it came from.
   *
   * Flow:
   *   1. Ownership check
   *   2. Validate approved content exists
   *   3. Look up CMS connection — if disconnected, return connection_lost error
   *   4. Decrypt credentials
   *   5. Call postBackToWordPress (handles all 4 error states)
   *   6. On success: setPostBackComplete + return confirmation data
   *   7. On failure: setPostBackFailed + surface error to client
   */
  runPostBack: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const { post, business } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );

      // ── Validate approved content ─────────────────────────────────────────
      if (!post.bodyApproved) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "No approved content found. Save your edits before posting back.",
        });
      }

      // ── Look up CMS connection ────────────────────────────────────────────
      const connections = await getCmsConnectionsByBusinessId(post.businessId);
      const connection = connections.find(
        (c) => c.platform === post.cmsPlatform
      );

      // Error state 1: CMS connection lost
      if (!connection || connection.connectionStatus !== "connected") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Your CMS connection has been lost. Please reconnect your WordPress site before posting back.",
          cause: { errorCode: "connection_lost" },
        });
      }

      // ── Decrypt credentials ───────────────────────────────────────────────
      let creds: WordPressCredentials;
      try {
        const raw = decryptConnectionCredentials(connection);
        creds = raw as unknown as WordPressCredentials;
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Could not read your CMS credentials. Please reconnect your WordPress site.",
          cause: { errorCode: "connection_lost" },
        });
      }

      // ── Execute post-back (multi-platform dispatch) ──────────────────────
      const altTexts = Array.isArray(post.bodyImageAlts)
        ? (post.bodyImageAlts as string[])
        : [];

      const postBackPayload = {
        cmsPostId: post.cmsPostId,
        bodyApproved: post.bodyApproved,
        metaTitle: post.metaTitleRewritten ?? "",
        metaDescription: post.metaDescriptionRewritten ?? "",
        authorIdCms: post.authorIdCms,
        bodyImageAlts: altTexts,
        schemaJson: post.schemaJson ?? null,
        postUrl: post.url ?? "",
        rewriteScore: post.rewriteScore ?? 0,
        rewriteGrade: post.rewriteGrade ?? "",
      };

      try {
        let result;
        if (post.cmsPlatform === "wordpress") {
          result = await postBackToWordPress(creds as unknown as WordPressCredentials, postBackPayload);
        } else if (post.cmsPlatform === "wix") {
          result = await postBackToWix(
            creds as unknown as WixCredentials,
            { cmsPostId: post.cmsPostId, bodyApproved: post.bodyApproved, metaTitle: post.metaTitleRewritten ?? "", metaDescription: post.metaDescriptionRewritten ?? "" },
            post.schemaJson ?? null
          );
        } else if (post.cmsPlatform === "shopify") {
          // Shopify requires blogId — stored in authorIdCms field for Shopify posts
          result = await postBackToShopify(
            creds as unknown as ShopifyCredentials,
            { cmsPostId: post.cmsPostId, blogId: post.authorIdCms ?? "", bodyApproved: post.bodyApproved, metaTitle: post.metaTitleRewritten ?? "", metaDescription: post.metaDescriptionRewritten ?? "" },
            post.schemaJson ?? null
          );
        } else if (post.cmsPlatform === "zapier") {
          result = await postBackViaZapier(
            creds as unknown as ZapierCredentials,
            { postId: post.id, title: post.title, bodyApproved: post.bodyApproved, metaTitle: post.metaTitleRewritten ?? "", metaDescription: post.metaDescriptionRewritten ?? "", scoreAfter: post.rewriteScore ?? 0, gradeAfter: post.rewriteGrade ?? "", postUrl: post.url ?? "" },
            post.schemaJson ?? null
          );
        } else {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Post-back is not supported for this CMS platform. Please export your post to update it manually.",
          });
        }

        // Mark as complete in DB
        await setPostBackComplete(input.postId);

        // Update connection status to confirm it is still connected
        await updateCmsConnectionStatus(connection.id, "connected", new Date());

        // Get current credit balance for Blog Batcher upsell
        const creditsRemaining = await getCreditsRemaining(input.iauditUserId);

        return {
          success: true as const,
          postTitle: post.title,
          postUrl: post.url,
          rewriteScore: post.rewriteScore,
          rewriteGrade: post.rewriteGrade,
          schemaInjected: result.schemaInjected,
          schemaFallbackJson: result.schemaFallbackJson,
          creditsRemaining,
          showBlogBatcherUpsell: creditsRemaining === 0,
        };
      } catch (err) {
        if (err instanceof PostBackException) {
          // Mark as failed in DB (except partial_failure — content was written)
          if (err.code !== "partial_failure") {
            await setPostBackFailed(input.postId).catch(() => {});
          }

          // Mark connection as error for connection-related failures
          if (err.code === "connection_lost" || err.code === "site_unreachable") {
            await updateCmsConnectionStatus(connection.id, "error").catch(() => {});
          }

          // Map to appropriate TRPCError codes
          const trpcCode =
            err.code === "insufficient_permissions"
              ? "FORBIDDEN"
              : err.code === "post_not_found"
              ? "NOT_FOUND"
              : err.code === "partial_failure"
              ? "PARTIAL_CONTENT" // custom — handled specially on client
              : "BAD_REQUEST";

          throw new TRPCError({
            code: trpcCode as any,
            message: err.message,
            cause: {
              errorCode: err.code,
              partialData: err.partialData,
            },
          });
        }

        // Unknown error
        await setPostBackFailed(input.postId).catch(() => {});
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "An unexpected error occurred while posting back to your CMS. Please try again.",
          cause: err,
        });
      }
    }),

  /**
   * postback.getPostBackStatus
   *
   * Returns the current post_back_status for a post.
   * Used to poll status after triggering a post-back.
   */
  getPostBackStatus: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const { post } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );

      return {
        postId: post.id,
        postBackStatus: post.postBackStatus,
        postTitle: post.title,
        postUrl: post.url,
        rewriteScore: post.rewriteScore,
        rewriteGrade: post.rewriteGrade,
      };
    }),
});
