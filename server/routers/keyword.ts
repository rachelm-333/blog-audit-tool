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
  getPostsWithoutKeyword,
  listPostsForBusiness,
  resetKeywordsForBusiness,
  saveKeyword,
  updateCannibalisationFlags,
  updatePostKeyword,
} from "../keyword.db";
import { detectCannibalisation, detectKeywordWithAI, extractKeywordFromTitle, suggestKeywordsForPost } from "../keyword.service";
import { getPostForAudit, saveAuditResults } from "../audit.db";
import type { AuditResultsJson } from "../audit.db";
import { runMechanicalChecks, scoreToGrade } from "../audit.service";
import type { AuditPoint } from "../audit.service";

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
        source: z.enum(["cms_scraped", "user_entered", "auto_detected", "ai_suggested"]),
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
            "ai_suggested",
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
          // Fetch full post body + meta fields for the strongest keyword signal
          const fullPost = await getPostForKeyword(post.id);
          const bodyHtml = fullPost?.bodyOriginal ?? "";
          const metaTitle = fullPost?.metaTitleOriginal ?? "";
          const metaDesc = fullPost?.metaDescriptionOriginal ?? "";
          const keyword = extractKeywordFromTitle(post.title, bodyHtml, metaTitle, metaDesc);
          if (!keyword) continue;
          await saveKeyword(post.id, keyword, [], "auto_detected", false);
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
   * keyword.resetAllKeywords
   * Clear focusKeyword + keywordSource for all posts in a business where
   * keywordSource is NOT 'user_entered'. This forces fresh AI detection on
   * the next import without touching manually curated keywords.
   */
  resetAllKeywords: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);
      const cleared = await resetKeywordsForBusiness(input.businessId);
      return { success: true, cleared };
    }),

  /**
   * keyword.detectAllKeywords
   * Run AI keyword detection on all posts with no keyword set, in batches of 10.
   * Returns progress after each batch so the client can show a live counter.
   * Only processes posts where focusKeyword IS NULL.
   */
  detectAllKeywords: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
        batchOffset: z.number().int().min(0).default(0),
        batchSize: z.number().int().min(1).max(10).default(10),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      // Fetch all posts without a keyword at query time
      const allPosts = await getPostsWithoutKeyword(input.businessId);
      const total = allPosts.length;

      if (total === 0) {
        return { processed: 0, succeeded: 0, failed: 0, total: 0, done: true };
      }

      // Slice the requested batch
      const batch = allPosts.slice(input.batchOffset, input.batchOffset + input.batchSize);
      let succeeded = 0;
      let failed = 0;

      for (const post of batch) {
        try {
          // Extract slug from URL (last path segment)
          const slug = post.url ? post.url.split("/").filter(Boolean).pop() ?? "" : "";
          const keyword = await detectKeywordWithAI(post.title, post.bodyOriginal ?? "", slug);
          if (keyword) {
            await updatePostKeyword(post.id, keyword, "ai_detected");
            succeeded++;
          } else {
            // AI returned nothing — fall back to title extraction
            const fallback = extractKeywordFromTitle(post.title, post.bodyOriginal ?? "", post.metaTitleOriginal ?? "");
            if (fallback) {
              await updatePostKeyword(post.id, fallback, "slug");
            }
            failed++;
          }
        } catch (err: any) {
          console.error(`[detectAllKeywords] Failed for post ${post.id}:`, err?.message);
          failed++;
        }
      }

      const processed = input.batchOffset + batch.length;
      const done = processed >= total;

      return { processed, succeeded, failed, total, done };
    }),

  /**
   * keyword.updateAndRescore
   * Save a manually edited keyword (source = user_entered) and immediately
   * re-score the SEO audit using the new keyword.
   *
   * Strategy: re-run mechanical checks (P1–P8, P13, P16) with the new keyword,
   * then merge with the stored AI scores (P9–P12, P14–P15) from the last audit.
   * This gives an updated score in milliseconds without a new AI call.
   * If the post has never been audited, the mechanical-only score is saved.
   * Content is NEVER modified.
   */
  updateAndRescore: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        keyword: z.string().min(1).max(255).trim(),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      // 1. Ownership check
      const post = await assertPostOwnership(input.postId, input.iauditUserId);

      // 2. Save keyword as user_entered
      await updatePostKeyword(input.postId, input.keyword, "user_entered");

      // 3. Re-score only if the post has been audited before
      const auditPost = await getPostForAudit(input.postId);
      if (!auditPost || auditPost.auditStatus !== "complete" || !auditPost.auditResults) {
        // No prior audit — just save keyword, return without rescoring
        return { success: true, rescored: false };
      }

      // 4. Re-run mechanical checks with the new keyword
      const mechanicalPoints = runMechanicalChecks({
        title: auditPost.title,
        bodyHtml: auditPost.bodyOriginal ?? "",
        url: auditPost.url ?? "",
        focusKeyword: input.keyword,
        metaTitle: auditPost.metaTitleOriginal ?? null,
        metaDescription: auditPost.metaDescriptionOriginal ?? null,
      });

      // 5. Extract stored AI points from the previous audit results
      const storedResults = auditPost.auditResults as unknown as AuditResultsJson;
      const aiPointIds = new Set(["P9", "P10", "P11", "P12", "P14", "P15"]);
      const storedAiPoints: AuditPoint[] = (storedResults?.points ?? []).filter(
        (p: AuditPoint) => aiPointIds.has(p.point)
      );

      // 6. Merge mechanical + AI points in P1–P16 order
      const byPoint: Record<string, AuditPoint> = {};
      for (const p of [...mechanicalPoints, ...storedAiPoints]) {
        byPoint[p.point] = p;
      }
      const allPoints: AuditPoint[] = [];
      for (let i = 1; i <= 16; i++) {
        const key = `P${i}`;
        if (byPoint[key]) allPoints.push(byPoint[key]);
      }

      // 7. Compute new score and grade
      const score = allPoints.filter(
        (p) => p.status === "pass" || p.status === "na"
      ).length;
      const grade = scoreToGrade(score);
      const potentialScore = allPoints.filter(
        (p) => p.status === "pass" || p.status === "na" || p.status === "unable_to_score"
      ).length;

      // 8. Persist updated audit results
      await saveAuditResults(input.postId, score, grade, {
        points: allPoints,
        potentialScore,
      });

      return {
        success: true,
        rescored: true,
        score,
        grade,
        potentialScore,
        points: allPoints,
      };
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
