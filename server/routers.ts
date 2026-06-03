import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { iauthRouter } from "./routers/iauth";
import { businessRouter } from "./routers/business";
import { cmsRouter } from "./routers/cms";
import { keywordRouter } from "./routers/keyword";
import { auditRouter } from "./routers/audit";
import { rewriteRouter } from "./routers/rewrite";
import { reviewRouter } from "./routers/review";
import { postbackRouter } from "./routers/postback";
import { publicAuditRouter } from "./routers/publicAudit";
import { dashboardRouter } from "./routers/dashboard";
import { creditsRouter } from "./routers/credits";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // iAudit application auth (email + password, JWT, refresh tokens)
  iauth: iauthRouter,

  // iAudit business profile (Stage 1 — scrape + review)
  business: businessRouter,

  // iAudit CMS connection and post import (Layer 4)
  cms: cmsRouter,

  // iAudit keyword identification (Layer 5)
  keyword: keywordRouter,

  // iAudit audit engine (Layer 6)
  audit: auditRouter,

  // iAudit rewrite engine (Layer 7)
  rewrite: rewriteRouter,

  // iAudit review and edit (Layer 8)
  review: reviewRouter,

  // iAudit post back to CMS (Layer 9)
  postback: postbackRouter,

  // iAudit free public audit tool (Layer 10)
  publicAudit: publicAuditRouter,

  // iAudit dashboard (Layer 11)
  dashboard: dashboardRouter,

  // iAudit credits and Stripe (Layer 12)
  credits: creditsRouter,

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
