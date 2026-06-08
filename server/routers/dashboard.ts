/**
 * routers/dashboard.ts — Layer 11 Dashboard tRPC procedures.
 *
 * Procedures:
 *   dashboard.getStats      — 4 stat cards + grade breakdown + banners
 *   dashboard.getPostTable  — filterable / sortable post table
 *
 * Auth: publicProcedure + manual iauditUserId ownership validation
 * (mirrors the pattern used in audit.ts, rewrite.ts, etc.)
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../_core/trpc";
import { getBusinessesByUserId, getBusinessById } from "../businesses.db";
import { getCmsConnectionsByBusinessId } from "../cms.db";
import { getDashboardStats, getPostTableRows, getReviewQueuePosts } from "../dashboard.db";
import { getCreditsRemaining } from "../rewrite.db";

// ---------------------------------------------------------------------------
// Ownership guard
// ---------------------------------------------------------------------------

async function assertBusinessOwnership(
  businessId: string,
  iauditUserId: string
) {
  const business = await getBusinessById(businessId);
  if (!business || business.userId !== iauditUserId) {
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

export const dashboardRouter = router({
  /**
   * getStats — returns all data needed for the dashboard header:
   *   - 4 stat cards (health score, score potential, post counts, credits)
   *   - grade breakdown (4 grade band counts)
   *   - cannibalisation warning data
   *   - score potential banner data
   *   - audit state (needsFirstAudit, auditedPostCount)
   *   - business info (name, site URL, last sync)
   *   - list of all businesses for this user (for agency business switcher)
   */
  getStats: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      const business = await assertBusinessOwnership(
        input.businessId,
        input.iauditUserId
      );

      const [stats, connections, creditsRemaining, allBusinesses] =
        await Promise.all([
          getDashboardStats(input.businessId),
          getCmsConnectionsByBusinessId(input.businessId),
          getCreditsRemaining(input.iauditUserId),
          getBusinessesByUserId(input.iauditUserId),
        ]);

      // Connection info for the sub-heading
      const primaryConnection = connections.find(
        (c) => c.connectionStatus === "connected"
      ) ?? connections[0] ?? null;

      return {
        business: {
          id: business.id,
          name: business.businessName,
          siteUrl: business.websiteUrl,
        },
        allBusinesses: allBusinesses.map((b) => ({
          id: b.id,
          name: b.businessName,
          siteUrl: b.websiteUrl,
        })),
        connection: primaryConnection
          ? {
              platform: primaryConnection.platform,
              siteUrl: primaryConnection.siteUrl,
              connectionStatus: primaryConnection.connectionStatus,
              lastSyncAt: primaryConnection.lastSyncAt,
            }
          : null,
        stats,
        creditsRemaining,
        lowCredits: creditsRemaining < 10,
      };
    }),

  /**
   * getPostTable — returns the filterable / sortable post table rows.
   */
  getPostTable: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
        gradeFilter: z
          .enum(["all", "optimised", "strong", "needs_work", "poor", "critical"])
          .default("all"),
        statusFilter: z
          .enum(["all", "published", "scheduled", "draft", "awaiting_review", "approved"])
          .default("all"),
        sortField: z.enum(["score", "grade", "title"]).default("score"),
        sortDir: z.enum(["asc", "desc"]).default("asc"),
      })
    )
    .query(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);

      const rows = await getPostTableRows(
        input.businessId,
        input.gradeFilter,
        input.statusFilter,
        input.sortField,
        input.sortDir
      );

      return { rows };
    }),

  /**
   * getReviewQueue — returns all posts in awaiting_review status for the review queue page.
   */
  getReviewQueue: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);
      const posts = await getReviewQueuePosts(input.businessId);
      return { posts };
    }),

  /**
   * approvePost — moves a post from awaiting_review to approved status.
   */
  approvePost: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        businessId: z.string().min(1),
        postId: z.string().min(1),
      })
    )
    .mutation(async ({ input }) => {
      await assertBusinessOwnership(input.businessId, input.iauditUserId);
      const { setRewriteStatus } = await import("../rewrite.db");
      await setRewriteStatus(input.postId, "approved");
      return { success: true };
    }),

  /**
   * listBusinesses — returns all businesses for a user (used by agency
   * business switcher and the "no businesses" empty state check).
   */
  listBusinesses: publicProcedure
    .input(z.object({ iauditUserId: z.string().min(1) }))
    .query(async ({ input }) => {
      const businesses = await getBusinessesByUserId(input.iauditUserId);
      return {
        businesses: businesses.map((b) => ({
          id: b.id,
          name: b.businessName,
          siteUrl: b.websiteUrl,
          stage1Complete: b.stage1Complete,
        })),
      };
    }),
});
