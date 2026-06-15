/**
 * iAudit — Audit Engine Service (Layer 6 / Section 10)
 *
 * Implements the 16-Point Authority Standard scoring engine.
 *
 * Mechanical points (no AI required):
 *   P1  Keyword Density      — 0.5%–2.5% of word count, min 4 occurrences
 *   P2  Keyword in H1        — exact or near-exact match
 *   P3  Keyword in H2        — keyword or close variant in at least one H2
 *   P4  Keyword in H3        — keyword or variant in at least one H3 (if H3s exist)
 *   P5  Keyword in First 100 Words — first 150 words checked for flexibility
 *   P6  Keyword in URL       — keyword words appear in slug in sequence
 *   P7  Meta Title           — present, contains keyword, max 60 chars
 *   P8  Meta Description     — present, 140–160 chars
 *   P13 Schema Markup        — JSON-LD Article schema in page source
 *   P16 Word Count           — within target range for inferred article type
 *
 * AI-scored points (single LLM call per post):
 *   P9  Opening Answer Block — 40–60 word direct answer in opening
 *   P10 External Authority Link
 *   P11 Internal CTA Link    — uses CTA URLs from Business Profile
 *   P12 Internal Blog Link
 *   P14 E-E-A-T Signals
 *   P15 Human Authenticity
 */

import { invokeClaude } from "./_core/claude";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditPointStatus = "pass" | "fail" | "na" | "unable_to_score";

export interface AuditPoint {
  point: string; // e.g. "P1"
  name: string;
  status: AuditPointStatus;
  note: string; // Plain-English explanation
}

export interface AuditResult {
  points: AuditPoint[];
  score: number; // 0–16
  grade: "optimised" | "strong" | "needs_work" | "poor" | "critical";
  potentialScore: number; // Max achievable if all fixable points pass
}

export interface PostAuditInput {
  title: string;
  bodyHtml: string; // Original HTML body
  url: string; // Full permalink
  focusKeyword: string | null; // Null = no keyword set; keyword checks auto-fail
  metaTitle: string | null;
  metaDescription: string | null;
  // Business profile fields for P11
  primaryCtaUrl?: string | null;
  secondaryCtaUrls?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML tags and return plain text */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Count words in a plain-text string */
function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Normalise a string: lowercase, collapse whitespace */
function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Check if text contains the keyword (case-insensitive, whole-word flexible) */
function containsKeyword(text: string, keyword: string): boolean {
  const kw = normalise(keyword);
  const t = normalise(text);
  return t.includes(kw);
}

/** Extract all headings of a given level from HTML */
function extractHeadings(html: string, level: 1 | 2 | 3): string[] {
  const regex = new RegExp(`<h${level}[^>]*>(.*?)<\/h${level}>`, "gi");
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    matches.push(stripHtml(m[1]));
  }
  return matches;
}

/** Extract URL slug from a full URL */
function extractSlug(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase();
  }
}

/** Check if keyword words appear in sequence in the slug */
function keywordInSlug(url: string, keyword: string): boolean {
  const slug = extractSlug(url);
  const kwWords = normalise(keyword).split(" ");
  // Build a regex that matches the words in sequence (separated by hyphens or slashes)
  const pattern = kwWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\-\\/]+");
  return new RegExp(pattern).test(slug);
}

/** Infer article type from word count */
function inferArticleType(wc: number): "cornerstone" | "pillar" | "cluster" {
  if (wc >= 2450) return "cornerstone"; // ~2500 ±50
  if (wc >= 1450) return "pillar";       // ~1500 ±50
  return "cluster";                      // ~1000–1200 ±50
}

/** Extract all external links from HTML as a plain list */
export function extractExternalLinks(html: string, siteUrl?: string): string[] {
  const links: string[] = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href.startsWith('http')) continue; // skip relative links
    if (siteUrl) {
      try {
        const linkDomain = new URL(href).hostname;
        const siteDomain = new URL(siteUrl).hostname;
        if (linkDomain === siteDomain || linkDomain.endsWith('.' + siteDomain)) continue; // skip internal
      } catch { /* ignore malformed URLs */ }
    }
    const anchor = m[2].replace(/<[^>]+>/g, '').trim();
    links.push(`${anchor} \u2192 ${href}`);
  }
  return links;
}

/** Extract all internal links from HTML (same domain as siteUrl, or relative paths) */
export function extractInternalLinks(html: string, siteUrl: string, currentUrl?: string): { anchor: string; href: string; path: string }[] {
  const links: { anchor: string; href: string; path: string }[] = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let siteDomain = '';
  let currentPath = '';
  try { siteDomain = new URL(siteUrl).hostname; } catch { /* ignore */ }
  try { currentPath = new URL(currentUrl ?? '').pathname; } catch { /* ignore */ }
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    const anchor = m[2].replace(/<[^>]+>/g, '').trim();
    if (!anchor) continue;
    let path = '';
    if (href.startsWith('/')) {
      // Relative link — always internal
      path = href;
    } else if (href.startsWith('http')) {
      try {
        const u = new URL(href);
        if (u.hostname !== siteDomain && !u.hostname.endsWith('.' + siteDomain)) continue; // external
        path = u.pathname;
      } catch { continue; }
    } else {
      continue; // skip mailto:, javascript:, etc.
    }
    // Skip if it points to the current page
    if (currentPath && path === currentPath) continue;
    links.push({ anchor, href, path });
  }
  return links;
}

/** Word count targets per article type (±50 words tolerance built into ranges) */
const ARTICLE_TYPE_TARGETS: Record<string, { min: number; max: number }> = {
  cornerstone: { min: 2450, max: 3250 }, // ~2500–3200 ±50
  pillar: { min: 1450, max: 1850 },       // ~1500–1800 ±50
  cluster: { min: 950, max: 1250 },       // ~1000–1200 ±50
};

/** Compute grade from score */
export function scoreToGrade(
  score: number
): "optimised" | "strong" | "needs_work" | "poor" | "critical" {
  if (score >= 15) return "optimised";
  if (score >= 13) return "strong";
  if (score >= 10) return "needs_work";
  if (score >= 6) return "poor";
  return "critical";
}

// ---------------------------------------------------------------------------
// Mechanical audit checks (P1–P8, P13, P16)
// ---------------------------------------------------------------------------

export function runMechanicalChecks(input: PostAuditInput): AuditPoint[] {
  const { title, bodyHtml, url, focusKeyword, metaTitle, metaDescription } = input;

  // When no keyword is set, auto-fail all keyword-dependent checks (P1–P7)
  if (!focusKeyword) {
    const noKwNote = "No focus keyword set — unable to score.";
    const bodyText = stripHtml(bodyHtml);
    const wc = wordCount(bodyText);
    const md = metaDescription?.trim() ?? "";
    const p8Present = md.length > 0;
    const p8Length = md.length >= 140 && md.length <= 160;
    const p8Pass = p8Present && p8Length;
    const hasSchema =
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>/i.test(bodyHtml) ||
      /"@type"\s*:\s*"Article"/i.test(bodyHtml) ||
      /"@type"\s*:\s*"BlogPosting"/i.test(bodyHtml);
    const articleType = inferArticleType(wc);
    const target = ARTICLE_TYPE_TARGETS[articleType];
    const p16Pass = wc >= target.min && wc <= target.max;
    return [
      { point: "P1", name: "Keyword Density", status: "fail", note: noKwNote },
      { point: "P2", name: "Keyword in H1", status: "fail", note: noKwNote },
      { point: "P3", name: "Keyword in H2", status: "fail", note: noKwNote },
      { point: "P4", name: "Keyword in H3", status: "na", note: "Not applicable." },
      { point: "P5", name: "Keyword in First 100 Words", status: "fail", note: noKwNote },
      { point: "P6", name: "Keyword in URL", status: "fail", note: noKwNote },
      { point: "P7", name: "Meta Title", status: "fail", note: noKwNote },
      {
        point: "P8", name: "Meta Description", status: p8Pass ? "pass" : "fail",
        note: !p8Present ? "Meta description is missing." : !p8Length ? "Meta description does not meet the required length." : "Meta description meets requirements.",
      },
      { point: "P13", name: "Schema Markup", status: hasSchema ? "pass" : "fail", note: hasSchema ? "Schema markup detected." : "No article schema found." },
      { point: "P16", name: "Article Type Structure", status: p16Pass ? "pass" : "fail", note: p16Pass ? "Word count is within the required range." : wc < target.min ? "Word count is below the minimum for this article type." : "Word count is above the maximum for this article type." },
    ];
  }

  const kw = normalise(focusKeyword);
  const bodyText = stripHtml(bodyHtml);
  const wc = wordCount(bodyText);
  const points: AuditPoint[] = [];

  // P1 — Keyword Density
  const kwWords = kw.split(" ");
  // Count non-overlapping occurrences of the full keyword phrase
  let kwCount = 0;
  const bodyLower = normalise(bodyText);
  let searchPos = 0;
  while (true) {
    const idx = bodyLower.indexOf(kw, searchPos);
    if (idx === -1) break;
    kwCount++;
    searchPos = idx + kw.length;
  }
  const density = wc > 0 ? (kwCount / wc) * 100 : 0;
  const p1Pass = kwCount >= 4 && density >= 0.5 && density <= 2.5;
  points.push({
    point: "P1",
    name: "Keyword Density",
    status: p1Pass ? "pass" : "fail",
    note: p1Pass
      ? "Keyword density is within the required range."
      : kwCount < 4
      ? "Keyword appears too infrequently — below the minimum."
      : density > 2.5
      ? "Keyword density is above the maximum — reduce repetition."
      : "Keyword density is below the minimum for SEO.",
  });

  // P2 — Keyword in H1
  const h1s = extractHeadings(bodyHtml, 1);
  // Also check the post title as H1
  const allH1s = [...h1s, title];
  const p2Pass = allH1s.some((h) => containsKeyword(h, focusKeyword));
  points.push({
    point: "P2",
    name: "Keyword in H1",
    status: p2Pass ? "pass" : "fail",
    note: p2Pass
      ? "Keyword found in H1."
      : "Keyword not found in H1 heading.",
  });

  // P3 — Keyword in H2
  const h2s = extractHeadings(bodyHtml, 2);
  const p3Pass = h2s.length === 0 ? false : h2s.some((h) => containsKeyword(h, focusKeyword));
  points.push({
    point: "P3",
    name: "Keyword in H2",
    status: h2s.length === 0 ? "fail" : p3Pass ? "pass" : "fail",
    note:
      h2s.length === 0
        ? "No H2 headings found."
        : p3Pass
        ? "Keyword found in H2."
        : "Keyword not found in any H2 heading.",
  });

  // P4 — Keyword in H3 (only scored if H3s exist)
  const h3s = extractHeadings(bodyHtml, 3);
  if (h3s.length === 0) {
    points.push({
      point: "P4",
      name: "Keyword in H3",
      status: "na",
      note: "Not applicable — no H3 headings found.",
    });
  } else {
    const p4Pass = h3s.some((h) => containsKeyword(h, focusKeyword));
    points.push({
      point: "P4",
      name: "Keyword in H3",
      status: p4Pass ? "pass" : "fail",
      note: p4Pass
        ? "Keyword found in H3."
        : "Keyword not found in any H3 heading.",
    });
  }

  // P5 — Keyword in First 100 Words (exact 100 words)
  const first100Words = bodyText.split(/\s+/).slice(0, 100).join(" ");
  const p5Pass = containsKeyword(first100Words, focusKeyword);
  points.push({
    point: "P5",
    name: "Keyword in First 100 Words",
    status: p5Pass ? "pass" : "fail",
    note: p5Pass
      ? "Keyword found in the opening section."
      : "Keyword not found in the opening section.",
  });

  // P6 — Keyword in URL
  // If no URL is stored (empty string), mark as na rather than falsely failing
  const urlTrimmed = url?.trim() ?? "";
  if (!urlTrimmed) {
    points.push({
      point: "P6",
      name: "Keyword in URL",
      status: "na",
      note: "URL not available — unable to check. Re-import the post or update the URL in your CMS.",
    });
  } else {
    const p6Pass = keywordInSlug(urlTrimmed, focusKeyword);
    points.push({
      point: "P6",
      name: "Keyword in URL",
      status: p6Pass ? "pass" : "fail",
      note: p6Pass
        ? "Keyword found in URL slug."
        : `Keyword not found in URL slug. Current slug: ${urlTrimmed}`,
    });
  }

  // P7 — Meta Title
  const mt = metaTitle?.trim() ?? "";
  const p7Present = mt.length > 0;
  const p7HasKw = p7Present && containsKeyword(mt, focusKeyword);
  // Google truncates meta titles at ~60 chars, but 10-char buffer is acceptable
  const p7TooLong = mt.length > 70;
  const p7TooShort = mt.length < 10;
  const p7LengthOk = !p7TooLong && !p7TooShort;
  const p7Pass = p7Present && p7HasKw && p7LengthOk;
  points.push({
    point: "P7",
    name: "Meta Title",
    status: p7Pass ? "pass" : "fail",
    note: !p7Present
      ? "Meta title is missing."
      : !p7HasKw
      ? `Meta title does not contain the keyword. Title: "${mt}"`
      : p7TooLong
      ? `Meta title is too long (${mt.length} chars, max 70). Shorten it to avoid truncation.`
      : p7TooShort
      ? "Meta title is too short."
      : `Meta title meets requirements (${mt.length} chars).`,
  });

  // P8 — Meta Description
  const md = metaDescription?.trim() ?? "";
  const p8Present = md.length > 0;
  // Standard: 140–160 chars
  const p8TooShort = md.length < 140;
  const p8TooLong = md.length > 160;
  const p8LengthOk = !p8TooShort && !p8TooLong;
  const p8Pass = p8Present && p8LengthOk;
  points.push({
    point: "P8",
    name: "Meta Description",
    status: p8Pass ? "pass" : "fail",
    note: !p8Present
      ? "Meta description is missing."
      : p8TooShort
      ? `Meta description is too short (${md.length} chars, min 140). Expand it.`
      : p8TooLong
      ? `Meta description is too long (${md.length} chars, max 160). Google will truncate it.`
      : `Meta description meets requirements (${md.length} chars).`,
  });

  // P13 — Schema Markup (look for JSON-LD Article schema in the body HTML)
  const hasSchema =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>/i.test(bodyHtml) ||
    /"@type"\s*:\s*"Article"/i.test(bodyHtml) ||
    /"@type"\s*:\s*"BlogPosting"/i.test(bodyHtml);
  points.push({
    point: "P13",
    name: "Schema Markup",
    status: hasSchema ? "pass" : "fail",
    note: hasSchema
      ? "Schema markup detected."
      : "No article schema found.",
  });

  // P16 — Word Count / Article Type
  const articleType = inferArticleType(wc);
  const target = ARTICLE_TYPE_TARGETS[articleType];
  const p16Pass = wc >= target.min && wc <= target.max;
  points.push({
    point: "P16",
    name: "Article Type Structure",
    status: p16Pass ? "pass" : "fail",
    note: p16Pass
      ? "Word count is within the required range."
      : wc < target.min
      ? "Word count is below the minimum for this article type."
      : "Word count is above the maximum for this article type.",
  });

  return points;
}

// ---------------------------------------------------------------------------
// AI audit scorer (P9–P12, P14–P15) — single LLM call
// ---------------------------------------------------------------------------

interface AiAuditInput {
  title: string;
  bodyHtml: string;
  focusKeyword: string | null;
  primaryCtaUrl?: string | null;
  secondaryCtaUrls?: string[];
  siteUrl?: string; // For P11/P12 internal link checks
  currentUrl?: string; // Full URL of the current post (to exclude self-links)
}

interface AiAuditOutput {
  P9: { status: AuditPointStatus; note: string };
  P10: { status: AuditPointStatus; note: string };
  P11: { status: AuditPointStatus; note: string };
  P12: { status: AuditPointStatus; note: string };
  P14: { status: AuditPointStatus; note: string };
}

export async function runAiChecks(input: AiAuditInput): Promise<AuditPoint[]> {
  const { title, bodyHtml, focusKeyword, primaryCtaUrl, secondaryCtaUrls = [], siteUrl } = input;

  const ctaUrls = [primaryCtaUrl, ...secondaryCtaUrls].filter(Boolean).join(", ");

  // Strip HTML to plain text for AI analysis — avoids feeding CSS/JS noise to the AI
  const bodyText = stripHtml(bodyHtml);

  // ---------------------------------------------------------------------------
  // P15 — Human Authenticity (deterministic banned-phrase check, no LLM)
  // ---------------------------------------------------------------------------
  const P15_BANNED_PHRASES = [
    "in today's world", "it's important to note", "it is important to note",
    "delve into", "game-changer", "game changer", "leverage", "synergy",
    "transformative", "it's crucial to", "it is crucial to",
    "one of the most important", "at the end of the day",
    "according to research", "studies show", "it has been shown",
    "navigating the complexities", "in today's competitive landscape",
    "in today's fast-paced", "in today's digital", "look no further",
    "cutting-edge", "state-of-the-art", "seamlessly", "robust solution",
    "tailored solutions", "tailored to your needs", "unlock your potential",
    "unlock the power", "empower your", "elevate your",
    "take your business to the next level", "in conclusion,", "to summarize,",
    "to summarise,", "it goes without saying", "needless to say",
    "as we all know", "the bottom line is", "at its core",
    "furthermore,", "moreover,", "essentially,", "ultimately,",
  ];
  const bodyLower = bodyText.toLowerCase();
  const p15FailingPhrase = P15_BANNED_PHRASES.find(p => bodyLower.includes(p));
  if (p15FailingPhrase) {
    console.log('[Audit] P15 failing phrase:', p15FailingPhrase);
  }
  const p15Pass = !p15FailingPhrase;
  const p15Result: AuditPoint = {
    point: "P15",
    name: "Human Authenticity",
    status: p15Pass ? "pass" : "fail",
    note: p15Pass ? "No AI language patterns detected." : "AI language patterns detected.",
  };

  // First 500 words of plain text for P9 opening answer block check
  const opening500Words = bodyText.split(/\s+/).slice(0, 500).join(" ");

  // Pre-extract external links mechanically for P10 — more reliable than asking AI to find them in raw HTML
  const externalLinks = extractExternalLinks(bodyHtml, siteUrl);
  const externalLinksText = externalLinks.length > 0
    ? `External links found in article:\n${externalLinks.slice(0, 20).join('\n')}`
    : "No external links detected in the article HTML.";

  // Pre-extract internal links mechanically for P11 and P12
  const internalLinks = siteUrl ? extractInternalLinks(bodyHtml, siteUrl, input.currentUrl) : [];
  // Categorise: blog links (path contains /blog/, /post/, /article/, /news/) vs other internal (CTA/shop/service)
  // Match blog paths including Wix-style /post/slug (no trailing slash required)
  const blogLinkPatterns = /\/blog\/|\/post\/|\/posts\/|\/article\/|\/articles\/|\/news\/|\/insights\/|\/post\b/i;
  const ctaLinkPatterns = /\/shop\/|\/store\/|\/product\/|\/product-page\/|\/services\/|\/service\/|\/contact\/|\/contact$|\/book\/|\/booking\/|\/buy\/|\/cart\/|\/checkout\/|\/order\//i;
  const internalBlogLinks = internalLinks.filter(l => blogLinkPatterns.test(l.path));
  const internalCtaLinks = internalLinks.filter(l => ctaLinkPatterns.test(l.path));
  // Any internal link that isn't a blog link is a potential CTA/navigation link
  const internalNonBlogLinks = internalLinks.filter(l => !blogLinkPatterns.test(l.path));

  const internalLinksText = internalLinks.length > 0
    ? `Internal links found in article (${internalLinks.length} total):\n` +
      internalLinks.slice(0, 30).map(l => `  "${l.anchor}" → ${l.href}`).join('\n')
    : "No internal links detected in the article HTML.";

  // Use plain text body (truncated to ~6000 words) for the main AI analysis
  const bodyForAi = bodyText.slice(0, 30000); // ~6000 words of plain text

  const systemPrompt = `You are an expert SEO auditor. You will analyse a blog post and score it on 6 specific criteria. 
Return ONLY valid JSON matching the exact schema provided. Do not fabricate links, statistics, or credentials.
Be strict but fair. Each point must have a "status" of "pass" or "fail" and a brief "note" (one short phrase only — do NOT reveal specific thresholds, counts, character limits, or scoring criteria). Keep notes minimal: for pass use phrases like "Found" or "Detected"; for fail use phrases like "Not found", "Missing", or "Not detected".`;

  const userPrompt = `Analyse this blog post and score it on the following 6 points. Return JSON only.

FOCUS KEYWORD: "${focusKeyword ?? "(not set — ignore keyword references)"}"
POST TITLE: "${title}"
CTA URLS (for P11): ${ctaUrls || "none provided"}
SITE URL (for P12): ${siteUrl || "unknown"}

OPENING 500 WORDS (plain text — use this for P9):
${opening500Words}

${externalLinksText}

${internalLinksText}

FULL ARTICLE (plain text — use this for P14, P15):
${bodyForAi}

Score these 6 points:

P9 - Opening Answer Block: Does the article open with a direct answer block? Look ONLY at the OPENING 500 WORDS provided above. This means: (1) a bold question or standalone question line appears near the top (NOT the article title — look for a question WITHIN the body text), AND (2) the very next paragraph directly answers that question in 40–80 words. The question is typically a "People Also Ask" style question (e.g. "What is...", "How do...", "Why is...", "What's the most..."). IMPORTANT: The article title is NOT the question — look for a question that appears AFTER the title in the body text. If a bold question followed by a direct answer paragraph exists in the opening section, this PASSES. Be generous — if the pattern is clearly there, mark it pass.

P10 - External Authority Link: Is there at least one link to a real external authority source (government, university, industry body, major publication) with relevant anchor text? Do NOT count internal links or generic commercial sites.

P11 - Internal CTA Link: Does the article contain at least one internal link to a commercial/conversion page — such as a shop, product page, service page, contact page, booking page, or any page that drives a business action? ${ctaUrls ? `Known CTA URLs to look for: ${ctaUrls}. ` : ''}The site domain is ${siteUrl || 'unknown'}. IMPORTANT: Use the INTERNAL LINKS list provided above. Any internal link to a non-blog page (e.g. product pages, shop, store, services, contact, booking) counts as a CTA link. If ANY internal link goes to a commercial-sounding page, mark this as PASS. Be generous — if there is a button or link with text like "Get your...", "Buy now", "Shop", "Book", "Contact us", "View product", or any call-to-action wording that links internally, this PASSES.

P12 - Internal Blog Link: Does the article contain at least one link to another blog post or article on the same site, using descriptive anchor text (not just "click here" or "read more")? The site domain is ${siteUrl || 'unknown'}. Use the INTERNAL LINKS list provided above — look for links to /blog/, /post/, /article/, /news/ paths on the same domain.

P14 - E-E-A-T Signals: Does the article demonstrate experience, expertise, authority, and trust through specific details? Look for: named credentials, specific data points with sources, years of experience, real case studies, or named professionals.

Return this exact JSON structure (notes must be very brief — one short phrase, no thresholds or criteria revealed):
{
  "P9": {"status": "pass|fail", "note": "e.g. \"Opening answer block found.\" or \"Opening answer block not detected.\""},
  "P10": {"status": "pass|fail", "note": "e.g. \"External authority link found.\" or \"No external authority link found.\""},
  "P11": {"status": "pass|fail", "note": "e.g. \"Internal CTA link found.\" or \"No internal CTA link found.\""},
  "P12": {"status": "pass|fail", "note": "e.g. \"Internal blog link found.\" or \"No internal blog link found.\""},
  "P14": {"status": "pass|fail", "note": "e.g. \"E-E-A-T signals detected.\" or \"E-E-A-T signals not detected.\""}
}`;

  try {
    const response = await invokeClaude({
      system: systemPrompt,
      messages: [
        { role: "user" as const, content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "audit_ai_scores",
          strict: true,
          schema: {
            type: "object",
            properties: {
              P9: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pass", "fail"] },
                  note: { type: "string" },
                },
                required: ["status", "note"],
                additionalProperties: false,
              },
              P10: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pass", "fail"] },
                  note: { type: "string" },
                },
                required: ["status", "note"],
                additionalProperties: false,
              },
              P11: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pass", "fail"] },
                  note: { type: "string" },
                },
                required: ["status", "note"],
                additionalProperties: false,
              },
              P12: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pass", "fail"] },
                  note: { type: "string" },
                },
                required: ["status", "note"],
                additionalProperties: false,
              },
              P14: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["pass", "fail"] },
                  note: { type: "string" },
                },
                required: ["status", "note"],
                additionalProperties: false,
              },
            },
            required: ["P9", "P10", "P11", "P12", "P14"],
            additionalProperties: false,
          },
        },
      },
    });

        const rawContent = response.choices?.[0]?.message?.content;
    if (!rawContent) throw new Error("Empty AI response");
    const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
    const parsed: AiAuditOutput = JSON.parse(content);

    return [
      { point: "P9", name: "Opening Answer Block", status: parsed.P9.status, note: parsed.P9.note },
      { point: "P10", name: "External Authority Link", status: parsed.P10.status, note: parsed.P10.note },
      { point: "P11", name: "Internal CTA Link", status: parsed.P11.status, note: parsed.P11.note },
      { point: "P12", name: "Internal Blog Link", status: parsed.P12.status, note: parsed.P12.note },
      { point: "P14", name: "E-E-A-T Signals", status: parsed.P14.status, note: parsed.P14.note },
      p15Result,
    ];
  } catch {
    // AI call failed — mark P9–P12, P14 as unable_to_score; P15 is deterministic so always return it
    const failureNote =
      "We could not complete the AI portion of this audit. The mechanical checks are shown below. Try re-running the audit.";
    return [
      { point: "P9", name: "Opening Answer Block", status: "unable_to_score", note: failureNote },
      { point: "P10", name: "External Authority Link", status: "unable_to_score", note: failureNote },
      { point: "P11", name: "Internal CTA Link", status: "unable_to_score", note: failureNote },
      { point: "P12", name: "Internal Blog Link", status: "unable_to_score", note: failureNote },
      { point: "P14", name: "E-E-A-T Signals", status: "unable_to_score", note: failureNote },
      p15Result,
    ];
  }
}

// ---------------------------------------------------------------------------
// Full audit runner
// ---------------------------------------------------------------------------

export async function runFullAudit(input: PostAuditInput): Promise<AuditResult> {
  const mechanicalPoints = runMechanicalChecks(input);

  const aiPoints = await runAiChecks({
    title: input.title,
    bodyHtml: input.bodyHtml,
    focusKeyword: input.focusKeyword,
    primaryCtaUrl: input.primaryCtaUrl,
    secondaryCtaUrls: input.secondaryCtaUrls,
    siteUrl: input.url ? new URL(input.url).origin : undefined,
    currentUrl: input.url, // Pass full URL so self-links are excluded from internal link list
  });

  // Merge: mechanical order is P1–P8, P13, P16; AI order is P9–P12, P14–P15
  // Final order: P1–P16
  const allPoints: AuditPoint[] = [];
  const byPoint: Record<string, AuditPoint> = {};
  for (const p of [...mechanicalPoints, ...aiPoints]) {
    byPoint[p.point] = p;
  }
  for (let i = 1; i <= 16; i++) {
    const key = `P${i}`;
    if (byPoint[key]) allPoints.push(byPoint[key]);
  }

  // Score: count pass (na counts as pass for scoring purposes — not applicable = not penalised)
  const score = allPoints.filter((p) => p.status === "pass" || p.status === "na").length;
  const grade = scoreToGrade(score);

  // Potential score: assume all fail/unable_to_score points could be fixed
  const potentialScore = allPoints.filter(
    (p) => p.status === "pass" || p.status === "na" || p.status === "unable_to_score"
  ).length;

  return { points: allPoints, score, grade, potentialScore };
}
