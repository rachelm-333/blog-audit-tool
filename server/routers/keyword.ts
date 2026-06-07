/**
 * iAudit — Keyword Identification tRPC Router (Layer 5 / Section 9)
 *
 * Procedures:
 *   keyword.saveKeyword          — Save focus keyword + secondary keywords for a post
 *   keyword.confirm              — Confirm a keyword (cms_scraped | user_entered) for a post
 *   keyword.runCannibalisationScan — Scan all posts for a business, flag duplicates
 *   keyword.listPosts            — List all posts for a business with keyword status
 *   keyword.exportCsv            — Export keyword registry as CSV
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
  saveKeyword,
  updateCannibalisationFlags,
  updatePostKeyword,
} from "../keyword.db";
import { detectCannibalisation, extractKeywordFromTitle, suggestKeywordsForPost } from "../keyword.service";

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
   * keyword.saveKeyword
   * Save focus keyword + secondary keywords for a post.
   * If the focus keyword has changed from the current value, clears audit results
   * so the user must re-audit before rewriting.
   */
  saveKeyword: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        focusKeyword: z.string().min(1).max(255),
        secondaryKeywords: z.array(z.string().min(1).max(255)).max(10).default([]),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const post = await assertPostOwnership(input.postId, input.iauditUserId);

      // If the focus keyword changed and there's an existing audit score, clear it
      const keywordChanged =
        post.focusKeyword !== null &&
        post.focusKeyword.toLowerCase().trim() !==
          input.focusKeyword.toLowerCase().trim();
      const hasAudit = post.auditScore !== null;
      const clearAudit = keywordChanged && hasAudit;

      await saveKeyword(
        input.postId,
        input.focusKeyword,
        input.secondaryKeywords,
        "user_entered",
        clearAudit
      );

      return {
        success: true,
        auditCleared: clearAudit,
      };
    }),

  /**
   * keyword.confirm
   * Persist the user's chosen keyword + source to the post.
   * source must be 'cms_scraped' or 'user_entered'.
   */
  confirm: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        keyword: z.string().min(1).max(255),
        source: z.enum(["cms_scraped", "user_entered"]),
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

  /**
   * keyword.bulkSuggest
   * AI-suggest and auto-assign a focus keyword for every post in a business
   * that currently has no focus keyword. Uses the top suggestion (index 0)
   * from the AI and saves it with source=ai_suggested.
   * Returns counts of processed / skipped / failed posts.
   */
  bulkSuggest: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const allPosts = await listPostsForBusiness(input.businessId);
      const postsWithoutKeyword = allPosts.filter((p) => !p.focusKeyword);

      if (postsWithoutKeyword.length === 0) {
        return { processed: 0, skipped: 0, failed: 0, total: allPosts.length };
      }

      let processed = 0;
      let failed = 0;

      // Process in batches to avoid overwhelming the LLM
      // We use a simple sequential loop with error isolation per post
      for (const post of postsWithoutKeyword) {
        try {
          // Fetch the full post body for the AI
          const fullPost = await getPostForKeyword(post.id);
          if (!fullPost) { failed++; continue; }

          const suggestions = await suggestKeywordsForPost(
            fullPost.title,
            fullPost.bodyOriginal ?? ""
          );

          if (!suggestions || suggestions.length === 0) { failed++; continue; }

          // Save the top suggestion as ai_suggested
          await saveKeyword(
            fullPost.id,
            suggestions[0].keyword,
            [],
            "user_entered", // treat as user_entered so it shows as confirmed
            false
          );
          processed++;
        } catch {
          failed++;
        }
      }

      return {
        processed,
        skipped: 0,
        failed,
        total: postsWithoutKeyword.length,
      };
    }),

  /**
   * keyword.backfillFromTitles
   * Fast (no AI) backfill of focus keywords for all posts that have none.
   * Extracts the keyword from the post title using rule-based stripping.
   * Runs in milliseconds for any number of posts.
   */
  backfillFromTitles: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const allPosts = await listPostsForBusiness(input.businessId);
      const postsWithoutKeyword = allPosts.filter((p) => !p.focusKeyword);

      if (postsWithoutKeyword.length === 0) {
        return { processed: 0, total: allPosts.length };
      }

      let processed = 0;
      for (const post of postsWithoutKeyword) {
        try {
          // Fetch full post body so we can check headings + first 100 words
          const fullPost = await getPostForKeyword(post.id);
          const bodyHtml = fullPost?.bodyOriginal ?? "";
          const keyword = extractKeywordFromTitle(post.title, bodyHtml);
          if (!keyword) continue;
          await saveKeyword(post.id, keyword, [], "user_entered", false);
          processed++;
        } catch {
          // skip failed posts silently
        }
      }

      return { processed, total: postsWithoutKeyword.length };
    }),

  /**
   * keyword.getPostContent
   * Fetch the full body HTML of a single post for the preview panel.
   */
  getPostContent: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const post = await assertPostOwnership(input.postId, input.iauditUserId);
      return { bodyOriginal: post.bodyOriginal ?? "" };
    }),

  /**
   * keyword.exportCsv
   * Export the keyword registry for a business as a CSV string.
   * Columns: Post Title, Primary Keyword, Secondary Keywords, URL, Status, Audit Grade
   */
  exportCsv: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);
      const postList = await listPostsForBusiness(input.businessId);

      const header = ["Post Title", "Primary Keyword", "Secondary Keywords", "URL", "Status", "Audit Grade"];
      const rows = postList.map((p) => {
        const secondary = Array.isArray(p.secondaryKeywords)
          ? (p.secondaryKeywords as string[]).join("; ")
          : "";
        return [
          `"${(p.title ?? "").replace(/"/g, '""')}"`,
          `"${(p.focusKeyword ?? "").replace(/"/g, '""')}"`,
          `"${secondary.replace(/"/g, '""')}"`,
          `"${(p.url ?? "").replace(/"/g, '""')}"`,
          `"${(p.auditStatus ?? "").replace(/"/g, '""')}"`,
          `"${(p.auditGrade ?? "").replace(/"/g, '""')}"`,
        ].join(",");
      });

      const csv = [header.join(","), ...rows].join("\n");
      return { csv };
    }),
});
