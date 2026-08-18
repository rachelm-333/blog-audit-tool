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
 *   4. If rewrite_score < 80 → auto-retry once from Pass 1
 *   5. If retry also scores < 80 → refund 1 credit, set rewrite_status = needs_manual_review,
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
import { applyFixers } from "../bloginatorFixers";
import { notifyOwner } from "../_core/notification";
import { logError } from "../admin.db";

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

      const paaQuestion = await lookupPaaQuestion(
        post.focusKeyword,
        post.title ?? "",
        post.bodyOriginal ?? "",
      );
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
   *   6. If score < 80 → auto-retry once
   *   7. If retry also fails → refund credit, set needs_manual_review, notify user
   *   8. Save result
   */
  runRewrite: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
        paaQuestion: z.string().min(1), // Confirmed by user in the PAA modal
        rewriteMode: z.enum(["full_rewrite", "smart_patch", "seo_refresh"]).default("seo_refresh"),
        preserveFaq: z.boolean().default(true),  // Preserve FAQ section verbatim (user toggle)
        preserveCta: z.boolean().default(true),  // Preserve CTA section verbatim (user toggle)
        userInstructions: z.string().optional(),  // Optional user instructions to guide the rewrite
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

      // --- Set status to running ---
      await setRewriteStatus(post.id, "running");

      // --- Build context ---
      const businessContext: BusinessContext = {
        businessName: business.businessName,
        websiteUrl: business.websiteUrl,
        brandVoice: business.brandVoice,
        tone: business.tone,
        targetAudience: business.targetAudience,
        targetAudienceProblems: business.targetAudienceProblems ?? null,
        brandVoiceAnalysis: business.brandVoiceAnalysis ?? null,
        uvp: business.uvp,
        services: (business.services as Array<{ name: string; description?: string }>) ?? [],
        primaryCtaUrl: business.primaryCtaUrl,
        primaryCtaLabel: business.primaryCtaLabel,
        secondaryCtas: (business.secondaryCtas as Array<{ url: string; label: string }>) ?? [],
        awardsCredentials: business.awardsCredentials,
      };

      const allPosts = await listPostsForBusiness(post.businessId);
      const internalLinks = buildInternalLinkMap(allPosts, post.id, post.publishDate);

      const failingPoints: string[] = [];
      if (post.auditResults) {
        const auditResults = post.auditResults as { points?: Array<{ point: string; name: string; status: string }> };
        for (const p of auditResults.points ?? []) {
          if (p.status === "fail") failingPoints.push(`${p.point} — ${p.name}`);
        }
      }

      const secondaryKeywords = Array.isArray(post.secondaryKeywords)
        ? (post.secondaryKeywords as string[])
        : typeof post.secondaryKeywords === "string" && post.secondaryKeywords
          ? (post.secondaryKeywords as string).split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];

      // --- Fire-and-forget: return immediately, run rewrite in background ---
      // Avoids 504 Gateway Timeout from the load balancer.
      // The frontend polls rewrite.getRewriteResult to check when status changes from 'running'.
      void (async () => {
        let rewriteResult;
        try {
          rewriteResult = await runFullRewrite({
            post: {
              id: post.id,
              title: post.title,
              bodyOriginal: post.bodyOriginal,
              url: post.url,
              focusKeyword: post.focusKeyword!,
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
            preserveFaq: input.preserveFaq,
            preserveCta: input.preserveCta,
            userInstructions: input.userInstructions,
            originalScore: typeof post.auditScore === 'number' ? post.auditScore : undefined,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isRegression = errMsg.includes('Rewrite quality check failed');
          await setRewriteStatus(post.id, isRegression ? 'pending' : 'failed');
          void logError({
            userId: input.iauditUserId,
            businessId: post.businessId,
            postId: post.id,
            errorType: "rewrite_failed",
            errorMessage: errMsg,
            layer: "layer_7_rewrite",
          });
          return;
        }

        // Deduct credit only after a successful result
        await deductCredit(input.iauditUserId, post.id);

        // Fixer loop for smart_patch
        if (input.rewriteMode === "smart_patch" && rewriteResult.rewriteScore < 90) {
          try {
            const fixerResult = await applyFixers({
              bodyHtml: rewriteResult.bodyRewritten,
              focusKeyword: post.focusKeyword!,
              url: post.url,
              metaTitle: rewriteResult.metaTitleRewritten,
              metaDescription: rewriteResult.metaDescriptionRewritten,
              businessName: business.businessName ?? undefined,
              websiteUrl: business.websiteUrl ?? undefined,
              internalLinks: internalLinks.map(l => ({ url: l.url, title: l.title })),
              primaryCtaUrl: business.primaryCtaUrl ?? undefined,
            }, 'adjust');
            if (fixerResult.finalAuditResult.normalized_score > rewriteResult.rewriteScore) {
              rewriteResult = {
                ...rewriteResult,
                bodyRewritten: fixerResult.output.bodyHtml,
                metaTitleRewritten: fixerResult.output.metaTitle,
                metaDescriptionRewritten: fixerResult.output.metaDescription,
                rewriteScore: fixerResult.finalAuditResult.normalized_score,
                rewriteGrade: fixerResult.finalAuditResult.grade as "optimised"|"strong"|"needs_work"|"poor"|"critical",
                auditResult: fixerResult.finalAuditResult,
              };
            }
          } catch (err) {
            console.warn('[Rewrite] Fixer loop failed:', err instanceof Error ? err.message : err);
          }
        }

        // Auto-retry if score < 80
        if (rewriteResult.rewriteScore < 80) {
          try {
            const retryFailingPoints: string[] = [];
            if (rewriteResult.auditResult?.points) {
              for (const p of rewriteResult.auditResult.points) {
                if (p.status === "fail") retryFailingPoints.push(`${p.point} — ${p.name}`);
              }
            }
            const retryResult = await runFullRewrite({
              post: {
                id: post.id,
                title: post.title,
                bodyOriginal: rewriteResult.bodyRewritten,
                url: post.url,
                focusKeyword: post.focusKeyword!,
                metaTitleOriginal: rewriteResult.metaTitleRewritten,
                metaDescriptionOriginal: rewriteResult.metaDescriptionRewritten,
                publishDate: post.publishDate,
                scheduledDate: post.scheduledDate,
                status: post.status,
              },
              businessContext,
              internalLinks,
              failingPoints: retryFailingPoints.length > 0 ? retryFailingPoints : failingPoints,
              paaQuestion: input.paaQuestion,
              secondaryKeywords,
              rewriteMode: input.rewriteMode,
              preserveFaq: input.preserveFaq,
              preserveCta: input.preserveCta,
              userInstructions: input.userInstructions,
            });
            if (retryResult.rewriteScore > rewriteResult.rewriteScore) {
              rewriteResult = retryResult;
            }
          } catch {
            // Retry failed — continue with first result
          }

          if (rewriteResult.rewriteScore < 80) {
            await refundCredit(input.iauditUserId, post.id);
            await saveRewriteResult(post.id, rewriteResult);
            await setRewriteStatus(post.id, "needs_manual_review");
            await notifyOwner({
              title: "iAudit — Rewrite Needs Review",
              content: `The rewrite for "${post.title}" scored ${rewriteResult.rewriteScore}/100 after two attempts. Credit refunded.`,
            });
            return;
          }
        }

        await saveRewriteResult(post.id, rewriteResult);
      })();

      // Return immediately — frontend polls getRewriteResult for status
      return { jobStarted: true };
    }),

  /**
   * rewrite.rerunRewrite
   * Re-run the full rewrite pipeline on a post that already has a paaQuestion stored.
   * Uses the stored paaQuestion — no modal needed.
   * Deducts a credit (same as runRewrite).
   */
  rerunRewrite: publicProcedure
    .input(
      z.object({
        postId: z.string().min(1),
        iauditUserId: z.string().min(1),
        paaQuestion: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const { post, business } = await assertPostOwnership(
        input.postId,
        input.iauditUserId
      );

      if (!post.focusKeyword) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This post has no focus keyword. Set a keyword before running the rewrite.",
        });
      }

      // --- Check credits ---
      const credits = await getCreditsRemaining(input.iauditUserId);
      if (credits <= 0) {
        throw new TRPCError({
          code: "PAYMENT_REQUIRED",
          message: "You have no credits remaining. Buy more to continue rewriting posts.",
        });
      }

      // --- Deduct 1 credit ---
      await deductCredit(input.iauditUserId, post.id);
      await setRewriteStatus(post.id, "running");

      const businessContext: BusinessContext = {
        businessName: business.businessName,
        websiteUrl: business.websiteUrl,
        brandVoice: business.brandVoice,
        tone: business.tone,
        targetAudience: business.targetAudience,
        targetAudienceProblems: business.targetAudienceProblems ?? null,
        brandVoiceAnalysis: business.brandVoiceAnalysis ?? null,
        uvp: business.uvp,
        services: (business.services as Array<{ name: string; description?: string }>) ?? [],
        primaryCtaUrl: business.primaryCtaUrl,
        primaryCtaLabel: business.primaryCtaLabel,
        secondaryCtas: (business.secondaryCtas as Array<{ url: string; label: string }>) ?? [],
        awardsCredentials: business.awardsCredentials,
      };
      const allPosts = await listPostsForBusiness(post.businessId);
      const internalLinks = buildInternalLinkMap(allPosts, post.id, post.publishDate);

      const failingPoints: string[] = [];
      if (post.auditResults) {
        const auditResults = post.auditResults as { points?: Array<{ point: string; name: string; status: string }> };
        for (const p of auditResults.points ?? []) {
          if (p.status === "fail") failingPoints.push(`${p.point} — ${p.name}`);
        }
      }

      const secondaryKeywords = Array.isArray(post.secondaryKeywords)
        ? (post.secondaryKeywords as string[])
        : typeof post.secondaryKeywords === "string" && post.secondaryKeywords
          ? (post.secondaryKeywords as string).split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];

      // --- Fire-and-forget: return immediately, run rewrite in background ---
      // This avoids 504 Gateway Timeout from the load balancer (hard 300s limit).
      // The frontend polls rewrite.getRewriteResult to check when status changes from 'running'.
      void (async () => {
        let rewriteResult;
        try {
          rewriteResult = await runFullRewrite({
            post: {
              id: post.id,
              title: post.title,
              bodyOriginal: post.bodyRewritten ?? post.bodyOriginal,
              url: post.url,
              focusKeyword: post.focusKeyword!, // validated above
              metaTitleOriginal: post.metaTitleRewritten ?? post.metaTitleOriginal,
              metaDescriptionOriginal: post.metaDescriptionRewritten ?? post.metaDescriptionOriginal,
              publishDate: post.publishDate,
              scheduledDate: post.scheduledDate,
              status: post.status,
            },
            businessContext,
            internalLinks,
            failingPoints,
            paaQuestion: input.paaQuestion,
            secondaryKeywords,
            rewriteMode: "full_rewrite",
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isParseError =
            errMsg.includes("JSON") ||
            errMsg.includes("position") ||
            errMsg.includes("Unexpected token") ||
            errMsg.includes("Unexpected end") ||
            errMsg.includes("Expected");
          if (isParseError) {
            try { await refundCredit(input.iauditUserId, post.id); } catch { /* ignore */ }
          }
          await setRewriteStatus(post.id, "failed");
          void logError({
            userId: input.iauditUserId,
            businessId: post.businessId ?? null,
            postId: post.id,
            errorType: "rewrite_failed",
            errorMessage: errMsg,
            layer: "layer_7_rewrite",
          });
          return;
        }

        // Auto-retry once if score < 80
        if (rewriteResult.rewriteScore < 80) {
          try {
            const retryFailingPoints: string[] = [];
            if (rewriteResult.auditResult?.points) {
              for (const p of rewriteResult.auditResult.points) {
                if (p.status === "fail") retryFailingPoints.push(`${p.point} — ${p.name}`);
              }
            }
            const retryResult = await runFullRewrite({
              post: {
                id: post.id,
                title: post.title,
                bodyOriginal: rewriteResult.bodyRewritten,
                url: post.url,
                focusKeyword: post.focusKeyword!, // validated above
                metaTitleOriginal: rewriteResult.metaTitleRewritten,
                metaDescriptionOriginal: rewriteResult.metaDescriptionRewritten,
                publishDate: post.publishDate,
                scheduledDate: post.scheduledDate,
                status: post.status,
              },
              businessContext,
              internalLinks,
              failingPoints: retryFailingPoints.length > 0 ? retryFailingPoints : failingPoints,
              paaQuestion: input.paaQuestion,
              secondaryKeywords,
              rewriteMode: "full_rewrite",
            });
            if (retryResult.rewriteScore > rewriteResult.rewriteScore) {
              rewriteResult = retryResult;
            }
          } catch {
            // Retry failed — continue with first result
          }
        }

        await saveRewriteResult(post.id, rewriteResult);
        const needsManualReview = rewriteResult.rewriteScore < 80;
        if (needsManualReview) {
          await refundCredit(input.iauditUserId, post.id);
          await setRewriteStatus(post.id, "needs_manual_review");
        }
        // else: rewriteStatus stays as awaiting_review (set by saveRewriteResult)
      })();

      // Return immediately — frontend polls getRewriteResult for status changes
      return { jobStarted: true };
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
