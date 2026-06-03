/**
 * iAudit — Agency Router (Layer 14)
 *
 * Procedures:
 *  - agency.listBusinesses  — returns all businesses for the user; throws FORBIDDEN for solo accounts
 *  - agency.canAddBusiness  — returns whether the user is allowed to add another business
 *
 * Auth: publicProcedure + manual iauditUserId validation (same pattern as all other iAudit routers).
 * Solo accounts are restricted to a single business — attempting to list or add via agency routes
 * returns a FORBIDDEN error with a clear message.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { getIauditUserById } from "../iauth.db";
import { getBusinessesByUserId } from "../businesses.db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the iAudit user and throw FORBIDDEN if they are a solo account.
 * Agency and admin accounts are allowed to proceed.
 */
async function assertAgencyAccount(iauditUserId: string) {
  const user = await getIauditUserById(iauditUserId);
  if (!user) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "User not found.",
    });
  }
  if (user.accountType === "solo") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Multi-client features are only available on Agency accounts.",
    });
  }
  return user;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const agencyRouter = router({
  /**
   * listBusinesses — returns all businesses for the authenticated agency user.
   * Throws FORBIDDEN if the user is a solo account.
   */
  listBusinesses: publicProcedure
    .input(z.object({ iauditUserId: z.string().uuid() }))
    .query(async ({ input }) => {
      await assertAgencyAccount(input.iauditUserId);
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

  /**
   * canAddBusiness — returns whether the user is allowed to add another business.
   * Solo accounts: only allowed if they have 0 businesses.
   * Agency/admin accounts: always allowed.
   */
  canAddBusiness: publicProcedure
    .input(z.object({ iauditUserId: z.string().uuid() }))
    .query(async ({ input }) => {
      const user = await getIauditUserById(input.iauditUserId);
      if (!user) {
        throw new TRPCError({ code: "FORBIDDEN", message: "User not found." });
      }
      if (user.accountType === "solo") {
        const existing = await getBusinessesByUserId(input.iauditUserId);
        return {
          allowed: existing.length === 0,
          reason: existing.length > 0
            ? "Solo accounts are limited to one business. Upgrade to Agency to manage multiple clients."
            : null,
        };
      }
      return { allowed: true, reason: null };
    }),
});
