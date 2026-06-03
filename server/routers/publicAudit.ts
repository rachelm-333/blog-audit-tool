/**
 * routers/publicAudit.ts — Layer 10 tRPC router.
 *
 * All procedures use publicProcedure (no authentication required).
 *
 * Procedures:
 *  - runAudit: Scrape a public blog post URL and run the 16-point audit engine
 *  - runFreeRewrite: Gate on email uniqueness, run full Layer 7 pipeline, persist record
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../_core/trpc";
import { auditPublicPost } from "../public-audit.service";
import { runPublicFreeRewrite } from "../public-rewrite.service";
import {
  checkEmailUsed,
  recordFreeRewrite,
} from "../public-audit.db";
import type { AuditPoint } from "../audit.service";

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const runAuditInput = z.object({
  url: z.string().url("Please enter a valid URL including https://"),
  focusKeyword: z.string().optional(),
});

const runFreeRewriteInput = z.object({
  url: z.string().url(),
  focusKeyword: z.string().min(1, "Focus keyword is required"),
  auditScoreBefore: z.number().int().min(0).max(16),
  email: z.string().email("Please enter a valid email address"),
  businessName: z.string().min(1, "Business name is required"),
  industry: z.string().min(1, "Industry is required"),
  targetAudience: z.string().min(1, "Target audience is required"),
  primaryCtaUrl: z.string().url("Please enter a valid URL for your most important page"),
  brandVoice: z.enum(["Professional", "Friendly", "Bold", "Conversational"]),
  // Pass through the scraped content so we don't re-scrape
  scrapedTitle: z.string(),
  scrapedBodyHtml: z.string(),
  scrapedMetaTitle: z.string().nullable(),
  scrapedMetaDescription: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Output types (serialisable for tRPC)
// ---------------------------------------------------------------------------

export type PublicAuditPoint = {
  point: string;
  name: string;
  status: "pass" | "fail" | "na" | "unable_to_score";
  note: string;
};

export type RunAuditOutput = {
  url: string;
  title: string;
  score: number;
  grade: "optimised" | "strong" | "needs_work" | "poor" | "critical";
  potentialScore: number;
  points: PublicAuditPoint[];
  focusKeyword: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  // Scraped content — passed back to the client so Stage 2 doesn't re-scrape
  scrapedBodyHtml: string;
};

export type RunFreeRewriteOutput = {
  bodyRewritten: string;
  metaTitleRewritten: string;
  metaDescriptionRewritten: string;
  rewriteScore: number;
  rewriteGrade: "optimised" | "strong" | "needs_work" | "poor" | "critical";
  auditScoreBefore: number;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const publicAuditRouter = router({
  /**
   * Stage 1: Scrape a public blog post URL and run the 16-point audit.
   * No authentication required.
   */
  runAudit: publicProcedure
    .input(runAuditInput)
    .mutation(async ({ input }): Promise<RunAuditOutput> => {
      let result;
      try {
        result = await auditPublicPost(input.url, input.focusKeyword);
      } catch (err: any) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err?.message ?? "Failed to audit this URL. Please check it is a publicly accessible blog post.",
        });
      }

      const { scrape, audit } = result;

      return {
        url: scrape.url,
        title: scrape.title,
        score: audit.score,
        grade: audit.grade,
        potentialScore: audit.potentialScore,
        points: audit.points.map((p: AuditPoint) => ({
          point: p.point,
          name: p.name,
          status: p.status,
          note: p.note,
        })),
        focusKeyword: scrape.focusKeyword,
        metaTitle: scrape.metaTitle,
        metaDescription: scrape.metaDescription,
        scrapedBodyHtml: scrape.bodyHtml,
      };
    }),

  /**
   * Stage 2: Run the full Layer 7 rewrite pipeline for a free public rewrite.
   * Gates on email uniqueness — one free rewrite per email address.
   * Persists the result to free_rewrites table.
   * Does NOT deduct credits.
   */
  runFreeRewrite: publicProcedure
    .input(runFreeRewriteInput)
    .mutation(async ({ input }): Promise<RunFreeRewriteOutput> => {
      // --- Email gate: one free rewrite per address ---
      const alreadyUsed = await checkEmailUsed(input.email);
      if (alreadyUsed) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This email address has already used its free rewrite. Sign up for an account to fix all your posts.",
        });
      }

      // --- Run the full rewrite pipeline ---
      let rewriteResult;
      try {
        rewriteResult = await runPublicFreeRewrite({
          scrape: {
            url: input.url,
            title: input.scrapedTitle,
            bodyHtml: input.scrapedBodyHtml,
            bodyText: input.scrapedBodyHtml.replace(/<[^>]+>/g, " ").trim(),
            metaTitle: input.scrapedMetaTitle,
            metaDescription: input.scrapedMetaDescription,
            focusKeyword: input.focusKeyword,
            pageSource: input.scrapedBodyHtml,
          },
          focusKeyword: input.focusKeyword,
          auditScoreBefore: input.auditScoreBefore,
          businessProfile: {
            businessName: input.businessName,
            industry: input.industry,
            targetAudience: input.targetAudience,
            primaryCtaUrl: input.primaryCtaUrl,
            brandVoice: input.brandVoice,
          },
        });
      } catch (err: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err?.message ?? "Rewrite failed. Please try again.",
        });
      }

      // --- Persist the record (enforces DB-level unique constraint on email) ---
      try {
        await recordFreeRewrite({
          email: input.email,
          postUrl: input.url,
          auditScoreBefore: rewriteResult.auditScoreBefore,
          rewriteScoreAfter: rewriteResult.rewriteScore,
          bodyRewritten: rewriteResult.bodyRewritten,
          metaTitleRewritten: rewriteResult.metaTitleRewritten,
          metaDescriptionRewritten: rewriteResult.metaDescriptionRewritten,
        });
      } catch (err: any) {
        // If the DB unique constraint fires (race condition), treat as already used
        if (err?.code === "ER_DUP_ENTRY" || err?.message?.includes("Duplicate")) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "This email address has already used its free rewrite. Sign up for an account to fix all your posts.",
          });
        }
        // Other DB errors — still return the result (rewrite succeeded, just didn't persist)
        console.error("[publicAudit] Failed to persist free rewrite record:", err);
      }

      return {
        bodyRewritten: rewriteResult.bodyRewritten,
        metaTitleRewritten: rewriteResult.metaTitleRewritten,
        metaDescriptionRewritten: rewriteResult.metaDescriptionRewritten,
        rewriteScore: rewriteResult.rewriteScore,
        rewriteGrade: rewriteResult.rewriteGrade,
        auditScoreBefore: rewriteResult.auditScoreBefore,
      };
    }),
});
