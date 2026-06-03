import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { iauthRouter } from "./routers/iauth";
import { businessRouter } from "./routers/business";
import { cmsRouter } from "./routers/cms";
import { keywordRouter } from "./routers/keyword";
import { auditRouter } from "./routers/audit";

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

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
