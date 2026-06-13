/**
 * iAudit — Audit Engine tRPC Router (Layer 6 / Section 10)
 *
 * Procedures:
 *   audit.runAudit       — Run the 16-point audit on a single post (free, no credits)
 *   audit.runAuditAll    — Run the audit on all posts for a business (free, no credits)
 *   audit.getPostResults — Get audit results for a single post
 *   audit.getDashboard   — Get dashboard overview (health score, grade breakdown, score potential)
 *
 * Auth: publicProcedure + manual iauditUserId ownership validation.
 * Credits: ZERO — audits are always free.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getBusinessById } from "../businesses.db";
import {
  getPostForAudit,
  listPostsForDashboard,
  saveAuditResults,
  setAuditStatus,
  createAuditJob,
  updateAuditJobProgress,
  finishAuditJob,
  getAuditJob,
} from "../audit.db";
import { runFullAudit, scoreToGrade } from "../audit.service";

// ---------------------------------------------------------------------------
// Ownership helpers
// ---------------------------------------------------------------------------

async function assertPostOwnership(postId: string, iauditUserId: string) {
  const post = await getPostForAudit(postId);
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

export const auditRouter = router({
  /**
   * audit.runAudit
   * Run the 16-point audit on a single post. Free — no credits consumed.
   * Returns the full audit result immediately.
   */
  runAudit: publicProcedure
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

      // Mark as running
      await setAuditStatus(post.id, "running");

      try {
        // Extract secondary CTA URLs from business profile
        const secondaryCtas = (
          business.secondaryCtas as Array<{ url: string; label: string }> | null
        ) ?? [];
        const secondaryCtaUrls = secondaryCtas.map((c) => c.url);

        const result = await runFullAudit({
          title: post.title,
          bodyHtml: post.bodyOriginal,
          url: post.url,
          focusKeyword: post.focusKeyword,
          metaTitle: post.metaTitleOriginal,
          metaDescription: post.metaDescriptionOriginal,
          primaryCtaUrl: business.primaryCtaUrl,
          secondaryCtaUrls,
        });

        await saveAuditResults(post.id, result.score, result.grade, {
          points: result.points,
          potentialScore: result.potentialScore,
        });

        return {
          postId: post.id,
          score: result.score,
          grade: result.grade,
          potentialScore: result.potentialScore,
          points: result.points,
        };
      } catch (err) {
        await setAuditStatus(post.id, "failed");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            err instanceof Error ? err.message : "Audit failed unexpectedly.",
        });
      }
    }),

    /**
   * audit.runAuditAll
   * Starts an async batch audit job and returns a jobId immediately.
   * The frontend polls audit.getAuditJobStatus every 3 seconds.
   * Posts are processed in batches of 5 with a 30-second per-post timeout.
   * A single post failure does NOT crash the batch — it is logged and skipped.
   */
  runAuditAll: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      const business = await assertBusinessOwnership(
        input.businessId,
        input.iauditUserId
      );
      const allPosts = await listPostsForDashboard(input.businessId);
      if (allPosts.length === 0) {
        return { jobId: null, total: 0 };
      }

      const secondaryCtas = (
        business.secondaryCtas as Array<{ url: string; label: string }> | null
      ) ?? [];
      const secondaryCtaUrls = secondaryCtas.map((c) => c.url);

      // Create the job row immediately so the frontend can start polling
      const jobId = await createAuditJob(input.businessId, allPosts.length);

      // Run the batch asynchronously — do NOT await so we return the jobId right away
      (async () => {
        const BATCH_SIZE = 5;
        const POST_TIMEOUT_MS = 30_000;

        for (let i = 0; i < allPosts.length; i += BATCH_SIZE) {
          const batch = allPosts.slice(i, i + BATCH_SIZE);

          await Promise.all(
            batch.map(async (p) => {
              await setAuditStatus(p.id, "running");
              try {
                // Wrap each audit in a race against a 30-second timeout
                const result = await Promise.race([
                  (async () => {
                    const fullPost = await getPostForAudit(p.id);
                    if (!fullPost) throw new Error("Post not found");
                    return runFullAudit({
                      title: fullPost.title,
                      bodyHtml: fullPost.bodyOriginal,
                      url: fullPost.url,
                      focusKeyword: fullPost.focusKeyword,
                      metaTitle: fullPost.metaTitleOriginal,
                      metaDescription: fullPost.metaDescriptionOriginal,
                      primaryCtaUrl: business.primaryCtaUrl,
                      secondaryCtaUrls,
                    });
                  })(),
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("Audit timed out after 30s")), POST_TIMEOUT_MS)
                  ),
                ]);

                const fullPost = await getPostForAudit(p.id);
                if (fullPost) {
                  await saveAuditResults(fullPost.id, result.score, result.grade, {
                    points: result.points,
                    potentialScore: result.potentialScore,
                  });
                }
                await updateAuditJobProgress(jobId, { completedDelta: 1 });
              } catch (err) {
                await setAuditStatus(p.id, "failed");
                const errMsg = err instanceof Error ? err.message : String(err);
                await updateAuditJobProgress(jobId, {
                  failedPost: { postId: p.id, title: p.title ?? "", error: errMsg },
                });
              }
            })
          );
        }

        await finishAuditJob(jobId, "complete");
      })().catch(async (err) => {
        console.error("[runAuditAll] Unexpected batch error:", err);
        await finishAuditJob(jobId, "failed");
      });

      return { jobId, total: allPosts.length };
    }),

  /**
   * audit.getAuditJobStatus
   * Poll this every 3 seconds from the frontend to track batch audit progress.
   */
  getAuditJobStatus: publicProcedure
    .input(
      z.object({
        jobId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const job = await getAuditJob(input.jobId);
      if (!job) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Audit job not found." });
      }
      // Verify ownership via the business
      const business = await getBusinessById(job.businessId);
      if (!business || business.userId !== input.iauditUserId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied." });
      }
      return {
        jobId: job.id,
        status: job.status,
        total: job.total,
        completed: job.completed,
        failed: job.failed,
        failedPosts: (job.failedPosts as Array<{ postId: string; title: string; error: string }> | null) ?? [],
        startedAt: job.startedAt,
        finishedAt: job.finishedAt ?? null,
      };
    }),

  /**
   * audit.getPostResults
   * Get the stored audit results for a single post.
   */
  getPostResults: publicProcedure
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
        focusKeyword: post.focusKeyword,
        auditStatus: post.auditStatus,
        auditScore: post.auditScore,
        auditGrade: post.auditGrade,
        auditResults: post.auditResults as {
          points: Array<{
            point: string;
            name: string;
            status: string;
            note: string;
          }>;
          potentialScore: number;
        } | null,
        auditedAt: post.auditedAt,
      };
    }),

  /**
   * audit.getDashboard
   * Aggregate audit data for the dashboard overview:
   *   - Overall health score (average across audited posts)
   *   - Grade breakdown (count per grade band)
   *   - Score potential (average points that could be gained)
   *   - Cannibalisation warnings
   */
  getDashboard: publicProcedure
    .input(
      z.object({
        businessId: z.string().min(1),
        iauditUserId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const allPosts = await listPostsForDashboard(input.businessId);
      const auditedPosts = allPosts.filter(
        (p) => p.auditStatus === "complete" && p.auditScore !== null
      );

      const totalPosts = allPosts.length;
      const auditedCount = auditedPosts.length;
      const unarditedCount = totalPosts - auditedCount;

      // Overall health score — average across audited posts (1 decimal, matches dashboard.db.ts)
      const healthScore =
        auditedCount > 0
          ? Math.round(
              (auditedPosts.reduce((sum, p) => sum + (p.auditScore ?? 0), 0) /
                auditedCount) * 10
            ) / 10
          : null;

      // Grade breakdown
      const gradeBreakdown: Record<string, number> = {
        optimised: 0,
        strong: 0,
        needs_work: 0,
        poor: 0,
        critical: 0,
      };
      for (const p of auditedPosts) {
        if (p.auditGrade && p.auditGrade in gradeBreakdown) {
          gradeBreakdown[p.auditGrade]++;
        }
      }

      // Score potential — average potential score across poor + critical posts
      const poorAndCritical = auditedPosts.filter(
        (p) => p.auditGrade === "poor" || p.auditGrade === "critical"
      );
      const avgPotential =
        poorAndCritical.length > 0
          ? Math.round(
              poorAndCritical.reduce((sum, p) => {
                const results = p.auditResults as {
                  potentialScore?: number;
                } | null;
                return sum + (results?.potentialScore ?? 16);
              }, 0) / poorAndCritical.length
            )
          : null;

      // Score potential uplift
      const currentAvg = healthScore;
      const potentialAvg =
        auditedCount > 0 && avgPotential !== null
          ? Math.round(
              (auditedPosts.reduce((sum, p) => {
                const isPoorOrCritical =
                  p.auditGrade === "poor" || p.auditGrade === "critical";
                if (isPoorOrCritical) {
                  const results = p.auditResults as {
                    potentialScore?: number;
                  } | null;
                  return sum + (results?.potentialScore ?? 16);
                }
                return sum + (p.auditScore ?? 0);
              }, 0) /
                auditedCount)
            )
          : null;

      // Cannibalisation warnings
      const cannibalisedPosts = allPosts.filter((p) => p.cannibalizationFlag);
      const cannibalisationWarnings = cannibalisedPosts.map((p) => ({
        postId: p.id,
        title: p.title,
        focusKeyword: p.focusKeyword,
      }));

      // Uplift banner
      const upliftBanner =
        currentAvg !== null &&
        potentialAvg !== null &&
        potentialAvg > currentAvg &&
        poorAndCritical.length >= 3
          ? `Fixing your ${poorAndCritical.length} Poor and Critical posts could lift your blog health from ${currentAvg} to ${potentialAvg}`
          : null;

      return {
        totalPosts,
        auditedCount,
        unarditedCount,
        healthScore,
        healthGrade: healthScore !== null ? scoreToGrade(healthScore) : null,
        gradeBreakdown,
        poorAndCriticalCount: poorAndCritical.length,
        scoreUplift:
          currentAvg !== null && potentialAvg !== null
            ? potentialAvg - currentAvg
            : null,
        upliftBanner,
        cannibalisationWarnings,
      };
    }),
});
