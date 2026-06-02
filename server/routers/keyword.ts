/**
 * iAudit — Keyword Identification tRPC Router (Layer 5 / Section 9)
 *
 * Procedures:
 *   keyword.suggest              — AI-suggest top 3 focus keywords for a post with no keyword
 *   keyword.confirm              — Confirm a keyword (ai_suggested | user_entered) for a post
 *   keyword.runCannibalisationScan — Scan all posts for a business, flag duplicates
 *   keyword.listPosts            — List all posts for a business with keyword status
 *
 * Auth: publicProcedure + manual iauditUserId ownership validation.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getBusinessById } from "../businesses.db";
import {
  getPostForKeyword,
  listPostsForBusiness,
  updateCannibalisationFlags,
  updatePostKeyword,
} from "../keyword.db";
import {
  detectCannibalisation,
  suggestKeywordsForPost,
} from "../keyword.service";

// ---------------------------------------------------------------------------
// Ownership helpers
// ---------------------------------------------------------------------------

async function assertPostOwnership(postId: string, iauditUserId: string) {
  const post = await getPostForKeyword(postId);
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
  return post;
}

async function assertBusinessOwnership(
  businessId: string,
  iauditUserId: string
) {
  const business = await getBusinessById(businessId);
  if (!business) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Business not found." });
  }
  if (business.userId !== iauditUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have access to this business.",
    });
  }
  return business;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const keywordRouter = router({
  /**
   * keyword.suggest
   * For a post with no focus keyword, call the LLM and return 3 suggestions.
   * Returns the suggestions without persisting anything — the user must confirm.
   */
  suggest: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const post = await assertPostOwnership(input.postId, input.iauditUserId);

      const suggestions = await suggestKeywordsForPost(
        post.title,
        post.bodyOriginal
      );

      return {
        postId: post.id,
        suggestions,
      };
    }),

  /**
   * keyword.confirm
   * Persist the user's chosen keyword + source to the post.
   * source must be 'ai_suggested' or 'user_entered'.
   */
  confirm: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        keyword: z.string().min(1).max(255),
        source: z.enum(["ai_suggested", "user_entered"]),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      await assertPostOwnership(input.postId, input.iauditUserId);
      await updatePostKeyword(input.postId, input.keyword, input.source);
      return { success: true };
    }),

  /**
   * keyword.runCannibalisationScan
   * Scan all posts for a business, detect duplicate focus keywords,
   * and bulk-update cannibalization_flag in the DB.
   * Returns the duplicate groups for UI display.
   */
  runCannibalisationScan: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const allPosts = await listPostsForBusiness(input.businessId);
      const result = detectCannibalisation(allPosts);

      // Determine which posts should be unflagged
      const flaggedSet = new Set(result.flaggedPostIds);
      const unflaggedPostIds = allPosts
        .filter((p) => !flaggedSet.has(p.id))
        .map((p) => p.id);

      await updateCannibalisationFlags(result.flaggedPostIds, unflaggedPostIds);

      return {
        flaggedCount: result.flaggedPostIds.length,
        duplicateGroups: result.duplicateGroups,
      };
    }),

  /**
   * keyword.listPosts
   * List all posts for a business with keyword status info.
   * Used by the PostList page to render keyword badges.
   */
  listPosts: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);
      const postList = await listPostsForBusiness(input.businessId);
      return { posts: postList };
    }),
});
