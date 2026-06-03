/**
 * routers/credits.ts — Layer 12
 *
 * tRPC procedures for the Credits screen:
 *   credits.getBalance     — current balance + totals
 *   credits.getPacks       — list of credit packs with pricing
 *   credits.createCheckout — create Stripe Checkout session → returns URL
 *   credits.getHistory     — paginated credit transaction ledger
 *
 * The Stripe webhook is registered as a raw Express route in server/_core/index.ts
 * (must be raw body before express.json() for signature verification).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../_core/trpc";
import {
  getCreditsBalance,
  getCreditHistory,
} from "../credits.db";
import {
  createCheckoutSession,
  getCreditPacks,
} from "../stripe.service";

export const creditsRouter = router({
  // -------------------------------------------------------------------------
  // Get current credit balance
  // -------------------------------------------------------------------------
  getBalance: publicProcedure
    .input(z.object({ iauditUserId: z.string().min(1) }))
    .query(async ({ input }) => {
      return getCreditsBalance(input.iauditUserId);
    }),

  // -------------------------------------------------------------------------
  // Get credit packs (static, no DB call)
  // -------------------------------------------------------------------------
  getPacks: publicProcedure.query(() => {
    return getCreditPacks();
  }),

  // -------------------------------------------------------------------------
  // Create Stripe Checkout session
  // -------------------------------------------------------------------------
  createCheckout: publicProcedure
    .input(
      z.object({
        iauditUserId: z.string().min(1),
        userEmail: z.string().email(),
        userName: z.string(),
        packId: z.enum(["starter", "standard", "business", "agency"]),
        origin: z.string().url(),
      })
    )
    .mutation(async ({ input }) => {
      const successUrl = `${input.origin}/credits/success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${input.origin}/credits?cancelled=1`;

      try {
        const checkoutUrl = await createCheckoutSession({
          userId: input.iauditUserId,
          userEmail: input.userEmail,
          userName: input.userName,
          packId: input.packId,
          successUrl,
          cancelUrl,
        });
        return { checkoutUrl };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Payment could not be initiated: ${msg}`,
        });
      }
    }),

  // -------------------------------------------------------------------------
  // Credit history (ledger)
  // -------------------------------------------------------------------------
  getHistory: publicProcedure
    .input(z.object({ iauditUserId: z.string().min(1) }))
    .query(async ({ input }) => {
      return getCreditHistory(input.iauditUserId);
    }),
});
