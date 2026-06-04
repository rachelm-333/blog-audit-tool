/**
 * iAudit — Rewrite Engine tRPC Router (Layer 7 / Section 11)
 *
 * Procedures:
 *   rewrite.getPaaQuestion   — LLM lookup of the most relevant PAA question for a keyword
 *   rewrite.runRewrite       — Full two-pass rewrite pipeline with credit deduction + auto-retry
 *   rewrite.getRewriteResult — Get stored rewrite result for a post
 *
 * Credit flow:
 *   1. Check credits_remaining > 0 (throw INSUFFICIENT_CREDITS if not)
 *   2. Deduct 1 credit before Pass 1
 *   3. Run full rewrite pipeline
 *   4. If rewrite_score < 13 → auto-retry once from Pass 1
 *   5. If retry also scores < 13 → refund 1 credit, set rewrite_status = needs_manual_review,
 *      notify user
 *
 * Auth: publicProcedure + manual iauditUserId ownership validation.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getBusinessById } from "../businesses.db";
import {
  getPostForRewrite,
  setRewriteStatus,
  saveRewriteResult,
  deductCredit,
  refundCredit,
  getCreditsRemaining,
  listPostsForBusiness,
} from "../rewrite.db";
import {
  lookupPaaQuestion,
  buildInternalLinkMap,
  runFullRewrite,
} from "../rewrite.service";
import type { BusinessContext } from "../rewrite.service";
import { notifyOwner } from "../_core/notification";

// ---------------------------------------------------------------------------
// Ownership helpers
// ---------------------------------------------------------------------------
async function assertPostOwnership(postId: string, iauditUserId: string) {
  const post = await getPostForRewrite(postId);
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
export const rewriteRouter = router({
  /**
   * rewrite.getPaaQuestion
   * Look up the most relevant PAA question for a focus keyword.
   * Returns the suggested PAA question. User can confirm or type their own.
   */
  getPaaQuestion: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const { post } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );

      if (!post.focusKeyword) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This post has no focus keyword. Set a keyword before running the rewrite.",
        });
      }

      const paaQuestion = await lookupPaaQuestion(post.focusKeyword);
      return { paaQuestion };
    }),

  /**
   * rewrite.runRewrite
   * Full two-pass rewrite pipeline.
   *
   * Steps:
   *   1. Validate ownership and pre-conditions (keyword set, not cannibalised)
   *   2. Check credits_remaining > 0
   *   3. Deduct 1 credit
   *   4. Set rewrite_status = 'running'
   *   5. Run Pass 1 → Mechanical Enforcement → Pass 2 → Schema → Re-score
   *   6. If score < 13 → auto-retry once
   *   7. If retry also fails → refund credit, set needs_manual_review, notify user
   *   8. Save result
   */
  runRewrite: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
        paaQuestion: z.string().min(1), // Confirmed by user in the PAA modal
        rewriteMode: z.enum(["full_rewrite", "smart_patch"]).default("full_rewrite"),
      })
    )
    .mutation(async ({ input }) => {
      const { post, business } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );

      // --- Pre-condition checks ---
      if (!post.focusKeyword) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This post has no focus keyword. Set a keyword before running the rewrite.",
        });
      }

      if (post.cannibalizationFlag) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This post has a cannibalisation flag. Resolve the duplicate keyword before rewriting.",
        });
      }

      // --- Check credits ---
      const credits = await getCreditsRemaining(input.iauditUserId);
      if (credits <= 0) {
        throw new TRPCError({
          code: "PAYMENT_REQUIRED",
          message:
            "You have no credits remaining. Buy more to continue rewriting posts.",
        });
      }

      // --- Deduct 1 credit ---
      await deductCredit(input.iauditUserId, post.id);

      // --- Set status to running ---
      await setRewriteStatus(post.id, "running");

      // --- Build context ---
      const businessContext: BusinessContext = {
        businessName: business.businessName,
        websiteUrl: business.websiteUrl,
        brandVoice: business.brandVoice,
        tone: business.tone,
        targetAudience: business.targetAudience,
        uvp: business.uvp,
        services: (business.services as Array<{ name: string; description?: string }>) ?? [],
        primaryCtaUrl: business.primaryCtaUrl,
        primaryCtaLabel: business.primaryCtaLabel,
        secondaryCtas:
          (business.secondaryCtas as Array<{ url: string; label: string }>) ?? [],
        awardsCredentials: business.awardsCredentials,
      };

      // --- Build internal link map ---
      const allPosts = await listPostsForBusiness(post.businessId);
      const internalLinks = buildInternalLinkMap(
        allPosts,
        post.id,
        post.publishDate
      );

      // --- Extract failing audit points for context ---
      const failingPoints: string[] = [];
      if (post.auditResults) {
        const auditResults = post.auditResults as {
          points?: Array<{ point: string; name: string; status: string }>;
        };
        for (const p of auditResults.points ?? []) {
          if (p.status === "fail") {
            failingPoints.push(`${p.point} — ${p.name}`);
          }
        }
      }

      // --- Parse secondary keywords (needed for both first attempt and auto-retry) ---
      const secondaryKeywords = Array.isArray(post.secondaryKeywords)
        ? (post.secondaryKeywords as string[])
        : typeof post.secondaryKeywords === "string" && post.secondaryKeywords
          ? (post.secondaryKeywords as string).split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];

      // --- Run Pass 1 rewrite ---
      let rewriteResult;
      try {
        rewriteResult = await runFullRewrite({
          post: {
            id: post.id,
            title: post.title,
            bodyOriginal: post.bodyOriginal,
            url: post.url,
            focusKeyword: post.focusKeyword,
            metaTitleOriginal: post.metaTitleOriginal,
            metaDescriptionOriginal: post.metaDescriptionOriginal,
            publishDate: post.publishDate,
            scheduledDate: post.scheduledDate,
            status: post.status,
          },
          businessContext,
          internalLinks,
          failingPoints,
          paaQuestion: input.paaQuestion,
          secondaryKeywords,
          rewriteMode: input.rewriteMode,
        });
      } catch (err) {
        await setRewriteStatus(post.id, "failed");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Rewrite failed. Your credit has not been refunded as the attempt was made.",
        });
      }

      // --- Auto-retry if score < 13 ---
      if (rewriteResult.rewriteScore < 13) {
        try {
          const retryResult = await runFullRewrite({
            post: {
              id: post.id,
              title: post.title,
              // Use the first rewrite as input for the retry
              bodyOriginal: rewriteResult.bodyRewritten,
              url: post.url,
              focusKeyword: post.focusKeyword,
              metaTitleOriginal: rewriteResult.metaTitleRewritten,
              metaDescriptionOriginal: rewriteResult.metaDescriptionRewritten,
              publishDate: post.publishDate,
              scheduledDate: post.scheduledDate,
              status: post.status,
            },
            businessContext,
            internalLinks,
            failingPoints,
            paaQuestion: input.paaQuestion,
            secondaryKeywords,
            rewriteMode: input.rewriteMode,
          });

          if (retryResult.rewriteScore >= 13) {
            // Retry succeeded — save and return
            await saveRewriteResult(post.id, retryResult);
            return {
              success: true,
              rewriteScore: retryResult.rewriteScore,
              rewriteGrade: retryResult.rewriteGrade,
              needsManualReview: false,
              retried: true,
            };
          } else {
            // Both attempts failed — refund credit, set needs_manual_review
            await refundCredit(input.iauditUserId, post.id);
            await setRewriteStatus(post.id, "needs_manual_review");
            // Save the best result we have (the retry)
            await saveRewriteResult(post.id, retryResult);
            // Status already set to needs_manual_review above
            // Notify user
            await notifyOwner({
              title: "iAudit — Rewrite Needs Manual Review",
              content: `The rewrite for "${post.title}" scored ${retryResult.rewriteScore}/16 after two attempts. Your credit has been refunded. Please review the rewrite manually.`,
            });
            return {
              success: false,
              rewriteScore: retryResult.rewriteScore,
              rewriteGrade: retryResult.rewriteGrade,
              needsManualReview: true,
              retried: true,
              message:
                "The rewrite scored below 13/16 after two attempts. Your credit has been refunded. Please review the rewrite manually.",
            };
          }
        } catch {
          // Retry itself threw — refund and set needs_manual_review
          await refundCredit(input.iauditUserId, post.id);
          await setRewriteStatus(post.id, "needs_manual_review");
          await notifyOwner({
            title: "iAudit — Rewrite Auto-Retry Failed",
            content: `The auto-retry for "${post.title}" failed with an error. Credit refunded.`,
          });
          return {
            success: false,
            rewriteScore: rewriteResult.rewriteScore,
            rewriteGrade: rewriteResult.rewriteGrade,
            needsManualReview: true,
            retried: true,
            message:
              "The rewrite auto-retry failed. Your credit has been refunded. Please try again later.",
          };
        }
      }

      // --- Score ≥ 13 — save and return ---
      await saveRewriteResult(post.id, rewriteResult);
      return {
        success: true,
        rewriteScore: rewriteResult.rewriteScore,
        rewriteGrade: rewriteResult.rewriteGrade,
        needsManualReview: false,
        retried: false,
      };
    }),

  /**
   * rewrite.getRewriteResult
   * Get the stored rewrite result for a post.
   */
  getRewriteResult: publicProcedure
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
        title: post.title,
        rewriteStatus: post.rewriteStatus,
        rewriteScore: post.rewriteScore,
        rewriteGrade: post.rewriteGrade,
        bodyRewritten: post.bodyRewritten,
        metaTitleRewritten: post.metaTitleRewritten,
        metaDescriptionRewritten: post.metaDescriptionRewritten,
        paaQuestion: post.paaQuestion,
        articleType: post.articleType,
        // Audit score for comparison
        auditScore: post.auditScore,
        auditGrade: post.auditGrade,
      };
    }),
});
