/**
 * iAudit — Business Profile tRPC Router (Layer 3)
 *
 * Procedures:
 *  - business.startScrape      — validate URL, create pending business row, run scrape + AI inference
 *  - business.getScrapeStatus  — poll scrape status and get populated fields
 *  - business.getById          — get a business by ID (owner only)
 *  - business.list             — list all businesses for the authenticated user
 *  - business.save             — save partial or complete profile (Save Progress)
 *  - business.confirm          — validate required fields and set stage1_complete = true
 *
 * Auth: all procedures accept iauditUserId (UUID from the iAudit JWT) and validate ownership.
 * They use publicProcedure because the iAudit JWT is separate from the Manus OAuth session.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import type { InsertBusiness } from "../../drizzle/schema";
import type { ScrapedField } from "../scrape.service";
import {
  createBusiness,
  getBusinessById,
  getBusinessesByUserId,
  updateBusiness,
  confirmBusinessStage1,
} from "../businesses.db";
import { scrapeBusinessWebsite } from "../scrape.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Verify the requesting user owns the business */
async function assertOwnership(businessId: string, iauditUserId: string) {
  const biz = await getBusinessById(businessId);
  if (!biz) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Business not found." });
  }
  if (biz.userId !== iauditUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to access this business.",
    });
  }
  return biz;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const ServicesSchema = z.array(z.string().min(1));

const SaveBusinessInput = z.object({
  businessId: z.string().uuid(),
  iauditUserId: z.string().uuid(),
  businessName: z.string().optional(),
  websiteUrl: z.string().optional(),
  industry: z.string().optional(),
  location: z.string().optional(),
  yearsInBusiness: z.string().nullable().optional(),
  clientsServed: z.string().nullable().optional(),
  awardsCredentials: z.string().nullable().optional(),
  brandVoice: z.string().optional(),
  tone: z.string().optional(),
  targetAudience: z.string().optional(),
  languageStyle: z.string().nullable().optional(),
  uvp: z.string().optional(),
  services: ServicesSchema.optional(),
  primaryCtaUrl: z.string().optional(),
  primaryCtaLabel: z.string().optional(),
  competitors: z.array(z.string()).nullable().optional(),
});

// Required fields for stage1_complete (from Table 8 of scope)
const REQUIRED_FIELDS = [
  "businessName",
  "industry",
  "location",
  "brandVoice",
  "tone",
  "targetAudience",
  "uvp",
  "primaryCtaUrl",
] as const;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const businessRouter = router({
  /**
   * Start a scrape: validate URL, create a pending business row, run scrape + AI inference.
   * Returns the business ID immediately; client polls getScrapeStatus.
   * Note: scrape runs synchronously here (up to 30s) — for production, move to a queue.
   */
  startScrape: publicProcedure
    .input(
      z.object({
        websiteUrl: z.string().min(1, "Website URL is required"),
        iauditUserId: z.string().uuid("Invalid user ID"),
      })
    )
    .mutation(async ({ input }) => {
      const { websiteUrl, iauditUserId } = input;

      // Normalise URL
      let normalised: string;
      try {
        normalised = new URL(
          websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`
        ).href;
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "We could not reach that website. Please check the URL and try again.",
        });
      }

      // Create a pending business row
      const id = crypto.randomUUID();

      await createBusiness({
        id,
        userId: iauditUserId,
        websiteUrl: normalised,
        businessName: "",
        industry: "",
        location: "",
        brandVoice: "",
        tone: "",
        targetAudience: "",
        uvp: "",
        services: [],
        primaryCtaUrl: "",
        primaryCtaLabel: "",
        scrapeStatus: "pending",
        stage1Complete: false,
      });

      // Run the scrape (synchronous — up to 30s)
      let scrapeResult;
      try {
        scrapeResult = await scrapeBusinessWebsite(normalised);
      } catch (err) {
        await updateBusiness(id, { scrapeStatus: "failed" });
        return {
          businessId: id,
          scrapeStatus: "failed" as const,
          scrapeFailureType: "failed",
        };
      }

      // Determine status
      const isFailed =
        scrapeResult.failureReason === "unreachable" ||
        scrapeResult.failureReason === "robots_blocked";
      const status = isFailed ? "failed" : "complete";

      // Map scrape result fields to business row
      const services = scrapeResult.services.value
        ? (() => {
            try {
              const parsed = JSON.parse(scrapeResult.services.value);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return scrapeResult.services.value
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean);
            }
          })()
        : [];

      const competitorsRaw = (scrapeResult as Record<string, ScrapedField | unknown>)["competitors"] as { value?: string | null } | undefined;
      const competitors = competitorsRaw?.value
        ? (() => {
            try {
              const parsed = JSON.parse(competitorsRaw.value);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return competitorsRaw.value
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean);
            }
          })()
        : [];

      const updateData: Partial<InsertBusiness> = {
        scrapeStatus: status as "pending" | "complete" | "failed",
        scrapeFailureType: scrapeResult.failureReason ?? null,
        businessName: scrapeResult.businessName.value ?? "",
        industry: scrapeResult.industry.value ?? "",
        location: scrapeResult.location.value ?? "",
        brandVoice: scrapeResult.brandVoice.value ?? "",
        tone: scrapeResult.tone.value ?? "",
        targetAudience: scrapeResult.targetAudience.value ?? "",
        languageStyle: scrapeResult.languageStyle.value ?? null,
        uvp: scrapeResult.uvp.value ?? "",
        services,
        primaryCtaUrl: scrapeResult.primaryCtaUrl.value ?? "",
        primaryCtaLabel: scrapeResult.primaryCtaLabel.value ?? "",
        yearsInBusiness: scrapeResult.yearsInBusiness.value
          ? parseInt(scrapeResult.yearsInBusiness.value, 10) || null
          : null,
        clientsServed: scrapeResult.clientsServed.value
          ? parseInt(scrapeResult.clientsServed.value, 10) || null
          : null,
        awardsCredentials: scrapeResult.awardsCredentials.value ?? null,
        competitors,
      };

      await updateBusiness(id, updateData);

      return {
        businessId: id,
        scrapeStatus: status as "complete" | "failed",
        scrapeFailureType: scrapeResult.failureReason ?? null,
      };
    }),

  /**
   * Poll scrape status — returns the current business row including all scraped fields.
   */
  getScrapeStatus: publicProcedure
    .input(
      z.object({
        businessId: z.string().uuid(),
        iauditUserId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const biz = await assertOwnership(input.businessId, input.iauditUserId);
      return {
        scrapeStatus: biz.scrapeStatus,
        business: {
          businessName: biz.businessName,
          websiteUrl: biz.websiteUrl,
          industry: biz.industry,
          location: biz.location,
          yearsInBusiness: biz.yearsInBusiness?.toString() ?? "",
          clientsServed: biz.clientsServed?.toString() ?? "",
          awardsCredentials: biz.awardsCredentials ?? "",
          brandVoice: biz.brandVoice,
          tone: biz.tone,
          targetAudience: biz.targetAudience,
          languageStyle: biz.languageStyle ?? "",
          uvp: biz.uvp,
          services: Array.isArray(biz.services) ? (biz.services as string[]).join(", ") : "",
          primaryCtaUrl: biz.primaryCtaUrl,
          primaryCtaLabel: biz.primaryCtaLabel,
          competitors: Array.isArray(biz.competitors) ? (biz.competitors as string[]).join(", ") : "",
          scrapeFailureType: biz.scrapeFailureType ?? null,
        },
      };
    }),

  /**
   * Get a single business by ID (owner only).
   */
  getById: publicProcedure
    .input(
      z.object({
        businessId: z.string().uuid(),
        iauditUserId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      return assertOwnership(input.businessId, input.iauditUserId);
    }),

  /**
   * List all businesses for the authenticated iAudit user.
   */
  list: publicProcedure
    .input(z.object({ iauditUserId: z.string().uuid() }))
    .query(async ({ input }) => {
      return getBusinessesByUserId(input.iauditUserId);
    }),

  /**
   * Save Progress — partial or complete update to a business profile.
   * Always available, no required-field enforcement here.
   */
  save: publicProcedure
    .input(SaveBusinessInput)
    .mutation(async ({ input }) => {
      // Verify ownership
      await assertOwnership(input.businessId, input.iauditUserId);

      // Build update payload — only include defined fields
      const update: Record<string, unknown> = {};
      const fieldMap: Record<string, unknown> = {
        businessName: input.businessName,
        websiteUrl: input.websiteUrl,
        industry: input.industry,
        location: input.location,
        yearsInBusiness: input.yearsInBusiness
          ? parseInt(input.yearsInBusiness, 10) || null
          : input.yearsInBusiness === null ? null : undefined,
        clientsServed: input.clientsServed
          ? parseInt(input.clientsServed, 10) || null
          : input.clientsServed === null ? null : undefined,
        awardsCredentials: input.awardsCredentials,
        brandVoice: input.brandVoice,
        tone: input.tone,
        targetAudience: input.targetAudience,
        languageStyle: input.languageStyle,
        uvp: input.uvp,
        services: input.services,
        primaryCtaUrl: input.primaryCtaUrl,
        primaryCtaLabel: input.primaryCtaLabel,
        competitors: input.competitors,
      };
      for (const [k, v] of Object.entries(fieldMap)) {
        if (v !== undefined) update[k] = v;
      }

      await updateBusiness(input.businessId, update);
      return { success: true };
    }),

  /**
   * Confirm — validate all required fields, then set stage1_complete = true.
   */
  confirm: publicProcedure
    .input(
      z.object({
        businessId: z.string().uuid(),
        iauditUserId: z.string().uuid(),
      })
    )
    .mutation(async ({ input }) => {
      const biz = await assertOwnership(input.businessId, input.iauditUserId);

      // Server-side required field validation
      const missing: string[] = [];
      const requiredMap: Record<string, unknown> = {
        businessName: biz.businessName,
        industry: biz.industry,
        location: biz.location,
        brandVoice: biz.brandVoice,
        tone: biz.tone,
        targetAudience: biz.targetAudience,
        uvp: biz.uvp,
        primaryCtaUrl: biz.primaryCtaUrl,
      };
      for (const [k, v] of Object.entries(requiredMap)) {
        if (!v || (typeof v === "string" && v.trim() === "")) {
          missing.push(k);
        }
      }

      if (missing.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Please fill in all required fields before continuing: ${missing.join(", ")}`,
        });
      }

      await confirmBusinessStage1(input.businessId);
      return { success: true };
    }),
});
