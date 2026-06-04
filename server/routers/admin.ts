/**
 * admin.ts — Admin tRPC router (Layer 15)
 *
 * All procedures here accept iauditUserId as an input field (consistent with
 * all other iaudit procedures) and throw FORBIDDEN if the user's accountType
 * is not 'admin'.
 *
 * Procedures:
 *   admin.listUsers
 *   admin.addCredits
 *   admin.suspendUser
 *   admin.deleteUser
 *   admin.getUsageDashboard
 *   admin.getRevenueDashboard
 *   admin.getErrorLog
 *   admin.markErrorReviewed
 *   admin.downloadKeywordRegistry
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getIauditUserById } from "../iauth.db";
import {
  addCreditsToUser,
  deleteUserAndData,
  getErrorLog,
  getKeywordRegistryForUser,
  getRevenueDashboard,
  getUsageDashboard,
  listAllUsers,
  markErrorReviewed,
  setUserSuspended,
} from "../admin.db";

// ---------------------------------------------------------------------------
// Base input schema — every admin procedure requires iauditUserId
// ---------------------------------------------------------------------------
const adminBaseInput = z.object({ iauditUserId: z.string().uuid() });

// ---------------------------------------------------------------------------
// assertAdmin — helper called at the top of every procedure handler
// ---------------------------------------------------------------------------
async function assertAdmin(iauditUserId: string): Promise<void> {
  const user = await getIauditUserById(iauditUserId);
  if (!user || user.accountType !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required.",
    });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export const adminRouter = router({
  // -------------------------------------------------------------------------
  // listUsers — all iaudit_users with aggregated stats
  // -------------------------------------------------------------------------
  listUsers: publicProcedure
    .input(adminBaseInput)
    .query(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      return await listAllUsers();
    }),

  // -------------------------------------------------------------------------
  // addCredits — increment credits_remaining and log admin_grant transaction
  // -------------------------------------------------------------------------
  addCredits: publicProcedure
    .input(
      adminBaseInput.extend({
        userId: z.string().uuid(),
        credits: z.number().int().min(1).max(10000),
        note: z.string().min(1, "Note is required"),
      })
    )
    .mutation(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      await addCreditsToUser(input.userId, input.credits, input.note);
      return { success: true };
    }),

  // -------------------------------------------------------------------------
  // suspendUser — toggle isSuspended on a user row
  // -------------------------------------------------------------------------
  suspendUser: publicProcedure
    .input(
      adminBaseInput.extend({
        userId: z.string().uuid(),
        suspended: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      await setUserSuspended(input.userId, input.suspended);
      return { success: true };
    }),

  // -------------------------------------------------------------------------
  // deleteUser — hard-delete a user and all associated data
  // -------------------------------------------------------------------------
  deleteUser: publicProcedure
    .input(adminBaseInput.extend({ userId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      await deleteUserAndData(input.userId);
      return { success: true };
    }),

  // -------------------------------------------------------------------------
  // getUsageDashboard — platform-wide usage stats
  // -------------------------------------------------------------------------
  getUsageDashboard: publicProcedure
    .input(adminBaseInput)
    .query(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      return await getUsageDashboard();
    }),

  // -------------------------------------------------------------------------
  // getRevenueDashboard — Stripe purchase stats
  // -------------------------------------------------------------------------
  getRevenueDashboard: publicProcedure
    .input(adminBaseInput)
    .query(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      return await getRevenueDashboard();
    }),

  // -------------------------------------------------------------------------
  // getErrorLog — all error_log rows with user email and business name
  // -------------------------------------------------------------------------
  getErrorLog: publicProcedure
    .input(adminBaseInput)
    .query(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      return await getErrorLog();
    }),

  // -------------------------------------------------------------------------
  // markErrorReviewed — toggle reviewed on an error_log row
  // -------------------------------------------------------------------------
  markErrorReviewed: publicProcedure
    .input(
      adminBaseInput.extend({
        errorId: z.string().uuid(),
        reviewed: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      await markErrorReviewed(input.errorId, input.reviewed);
      return { success: true };
    }),

  // -------------------------------------------------------------------------
  // downloadKeywordRegistry — returns CSV rows for all businesses of a user
  // -------------------------------------------------------------------------
  downloadKeywordRegistry: publicProcedure
    .input(adminBaseInput.extend({ userId: z.string().uuid() }))
    .query(async ({ input }) => {
      await assertAdmin(input.iauditUserId);
      const rows = await getKeywordRegistryForUser(input.userId);
      // Build CSV string server-side so the frontend can trigger a download
      const header =
        "Business Name,Post Title,Primary Keyword,Secondary Keywords,Post URL,Post Status,Audit Grade";
      const csvRows = rows.map((r) =>
        [
          `"${r.businessName.replace(/"/g, '""')}"`,
          `"${r.postTitle.replace(/"/g, '""')}"`,
          `"${r.primaryKeyword.replace(/"/g, '""')}"`,
          `"${r.secondaryKeywords.replace(/"/g, '""')}"`,
          `"${r.postUrl.replace(/"/g, '""')}"`,
          r.postStatus,
          r.auditGrade,
        ].join(",")
      );
      const csv = [header, ...csvRows].join("\n");
      return { csv, rowCount: rows.length };
    }),
});
