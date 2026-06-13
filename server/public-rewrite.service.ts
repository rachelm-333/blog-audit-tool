/**
 * public-rewrite.service.ts — Layer 10 Stage 2 service.
 *
 * Runs the full Layer 7 rewrite pipeline (Pass 1 → Mechanical Enforcement →
 * Pass 2 Fingerprint Scrub → Re-score) for a free public rewrite.
 *
 * Key differences from the internal rewrite router (routers/rewrite.ts):
 *  - NO credit deduction — free rewrites are tracked separately in free_rewrites
 *  - NO stored post or business — uses the mini business profile from the form
 *  - NO cannibalisation check — no existing posts to compare against
 *  - Auto-retry if rewriteScore < 13 (same policy as Layer 7)
 *  - Returns the full RewriteResult for on-screen delivery
 */

import {
  runFullRewrite,
  lookupPaaQuestion,
  inferArticleType,
  type BusinessContext,
  type RewriteResult,
} from "./rewrite.service";
import { runFullAudit } from "./audit.service";
import type { PublicScrapeResult } from "./public-audit.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublicBusinessProfile {
  businessName: string;
  industry: string;
  targetAudience: string;   // "who is your customer"
  primaryCtaUrl: string;    // "most important page URL"
  brandVoice: "Professional" | "Friendly" | "Bold" | "Conversational";
}

export interface PublicRewriteInput {
  scrape: PublicScrapeResult;
  focusKeyword: string;
  auditScoreBefore: number;
  businessProfile: PublicBusinessProfile;
}

export interface PublicRewriteResult {
  bodyRewritten: string;
  metaTitleRewritten: string;
  metaDescriptionRewritten: string;
  rewriteScore: number;
  rewriteGrade: "optimised" | "strong" | "needs_work" | "poor" | "critical";
  auditScoreBefore: number;
}

// ---------------------------------------------------------------------------
// Brand voice tone map
// ---------------------------------------------------------------------------

const TONE_MAP: Record<PublicBusinessProfile["brandVoice"], string> = {
  Professional: "professional",
  Friendly: "friendly",
  Bold: "bold",
  Conversational: "conversational",
};

// ---------------------------------------------------------------------------
// Build a minimal BusinessContext from the public form
// ---------------------------------------------------------------------------

function buildPublicBusinessContext(
  profile: PublicBusinessProfile
): BusinessContext {
  const tone = TONE_MAP[profile.brandVoice];

  return {
    businessName: profile.businessName,
    websiteUrl: new URL(profile.primaryCtaUrl).origin,
    brandVoice: `Write in a ${tone} tone for ${profile.targetAudience}. Business: ${profile.businessName} (${profile.industry}).`,
    tone,
    targetAudience: profile.targetAudience,
    uvp: `${profile.businessName} — ${profile.industry}`,
    services: [{ name: profile.industry }],
    primaryCtaUrl: profile.primaryCtaUrl,
    primaryCtaLabel: "Learn More",
    secondaryCtas: [],
    awardsCredentials: null,
  };
}

// ---------------------------------------------------------------------------
// Main free rewrite function
// ---------------------------------------------------------------------------

/**
 * Run the full Layer 7 rewrite pipeline for a free public audit result.
 * Auto-retries once if the rewrite score is below 13.
 * Does NOT deduct credits.
 */
export async function runPublicFreeRewrite(
  input: PublicRewriteInput
): Promise<PublicRewriteResult> {
  const { scrape, focusKeyword, auditScoreBefore, businessProfile } = input;

  const businessContext = buildPublicBusinessContext(businessProfile);

  // Get PAA question for the keyword
  let paaQuestion: string;
  try {
    paaQuestion = await lookupPaaQuestion(
      focusKeyword,
      scrape.title ?? "",
      scrape.bodyHtml ?? "",
    );
  } catch {
    // If PAA lookup fails, use a generic question
    paaQuestion = `What do you need to know about ${focusKeyword}?`;
  }

  // Determine failing points from the audit (passed in via auditScoreBefore)
  // We need to re-run the audit to get the per-point breakdown for the rewrite prompt
  const auditInput = {
    title: scrape.title,
    bodyHtml: scrape.bodyHtml,
    url: scrape.url,
    focusKeyword,
    metaTitle: scrape.metaTitle,
    metaDescription: scrape.metaDescription,
    primaryCtaUrl: businessProfile.primaryCtaUrl,
    secondaryCtaUrls: [],
  };
  const auditResult = await runFullAudit(auditInput);
  const failingPoints = auditResult.points
    .filter((p) => p.status === "fail")
    .map((p) => `${p.point} — ${p.name}`);

  // Build a minimal post object for runFullRewrite
  const post = {
    id: "public-free-rewrite",
    title: scrape.title,
    bodyOriginal: scrape.bodyHtml,
    url: scrape.url,
    focusKeyword,
    metaTitleOriginal: scrape.metaTitle,
    metaDescriptionOriginal: scrape.metaDescription,
    publishDate: null,
    scheduledDate: null,
    status: "published",
  };

  // Run the full rewrite pipeline
  let result: RewriteResult = await runFullRewrite({
    post,
    businessContext,
    internalLinks: [], // No internal links for public rewrites
    failingPoints,
    paaQuestion,
  });

  // Auto-retry once if score is below 13 (same policy as Layer 7)
  if (result.rewriteScore < 13) {
    try {
      const retryResult = await runFullRewrite({
        post,
        businessContext,
        internalLinks: [],
        failingPoints,
        paaQuestion,
      });
      // Use retry result only if it scores higher
      if (retryResult.rewriteScore >= result.rewriteScore) {
        result = retryResult;
      }
    } catch {
      // Retry failed — use original result
    }
  }

  return {
    bodyRewritten: result.bodyRewritten,
    metaTitleRewritten: result.metaTitleRewritten,
    metaDescriptionRewritten: result.metaDescriptionRewritten,
    rewriteScore: result.rewriteScore,
    rewriteGrade: result.rewriteGrade,
    auditScoreBefore,
  };
}
