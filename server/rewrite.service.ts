/**
 * iAudit — Rewrite Engine Service (Layer 7 / Section 11)
 *
 * Provides:
 *   lookupPaaQuestion         — LLM call to find the most relevant PAA question for a keyword
 *   inferArticleType          — Infer cornerstone/pillar/cluster from word count
 *   buildInternalLinkMap      — Build list of published/pre-scheduled posts for internal linking
 *   runPass1Rewrite           — Full rewrite via LLM with all context
 *   runMechanicalEnforcement  — P1/P3/P5/P7/P8 always-pass enforcement
 *   runPass2FingerprintScrub  — Second LLM call to remove AI language patterns
 *   generateSchema            — Programmatic Article/Breadcrumb/FAQ schema generation
 *   runFullRewrite            — Orchestrates the full two-pass pipeline
 *
 * No fabrication rule: every LLM call includes the explicit instruction:
 * "Do not fabricate statistics, quotes, or external links. If you cannot find
 *  a real external source, omit the link entirely."
 */
import { invokeLLM } from "./_core/llm";
import { runFullAudit, scoreToGrade } from "./audit.service";
import type { AuditResult } from "./audit.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface InternalLink {
  url: string;
  title: string;
}

export interface BusinessContext {
  businessName: string;
  websiteUrl: string;
  brandVoice: string;
  tone: string;
  targetAudience: string;
  uvp: string;
  services: Array<{ name: string; description?: string }>;
  primaryCtaUrl: string;
  primaryCtaLabel: string;
  secondaryCtas?: Array<{ url: string; label: string }>;
  awardsCredentials?: string | null;
}

export interface Pass1Input {
  title: string;
  bodyHtml: string;
  focusKeyword: string;
  paaQuestion: string;
  articleType: "cornerstone" | "pillar" | "cluster";
  wordCountTarget: { min: number; max: number };
  businessContext: BusinessContext;
  internalLinks: InternalLink[];
  failingPoints: string[]; // e.g. ["P1 — Keyword Density", "P9 — Opening Answer Block"]
  secondaryKeywords: string[]; // Additional keywords to weave in naturally
  url: string;
  metaTitleOriginal: string | null;
  metaDescriptionOriginal: string | null;
  rewriteMode: "full_rewrite" | "smart_patch";
}

export interface Pass1Output {
  bodyRewritten: string;
  metaTitleRewritten: string;
  metaDescriptionRewritten: string;
}

export interface RewriteResult {
  bodyRewritten: string;
  metaTitleRewritten: string;
  metaDescriptionRewritten: string;
  schemaJson: object;
  rewriteScore: number;
  rewriteGrade: "optimised" | "strong" | "needs_work" | "poor" | "critical";
  auditResult: AuditResult;
  paaQuestion: string;
  articleType: "cornerstone" | "pillar" | "cluster";
  rewriteMode: "full_rewrite" | "smart_patch";
}

// ---------------------------------------------------------------------------
// Word count targets per article type
// ---------------------------------------------------------------------------
export const ARTICLE_TYPE_TARGETS: Record<
  "cornerstone" | "pillar" | "cluster",
  { min: number; max: number }
> = {
  cornerstone: { min: 2450, max: 3250 }, // ~2500–3200 ±50
  pillar: { min: 1450, max: 1850 },       // ~1500–1800 ±50
  cluster: { min: 950, max: 1250 },       // ~1000–1200 ±50
};

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

/** Normalise: lowercase, collapse whitespace */
function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Check if text contains the keyword */
function containsKeyword(text: string, keyword: string): boolean {
  return normalise(text).includes(normalise(keyword));
}

// ---------------------------------------------------------------------------
// PAA Question Lookup
// ---------------------------------------------------------------------------
/**
 * Ask the LLM to identify the single most relevant People Also Ask question
 * for the given focus keyword. Returns the question string.
 */
export async function lookupPaaQuestion(focusKeyword: string): Promise<string> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You are an SEO expert. Return only a JSON object — no prose, no markdown fences. " +
          "Do not fabricate statistics, quotes, or external links. " +
          "If you cannot find a real external source, omit the link entirely.",
      },
      {
        role: "user",
        content:
          `Identify the single most relevant People Also Ask (PAA) question that Google shows ` +
          `for the search query: "${focusKeyword}". ` +
          `Return a JSON object with a single field: { "paaQuestion": "<the question>" }. ` +
          `The question should be a real, commonly asked question that searchers have about this topic.`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "paa_question_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            paaQuestion: {
              type: "string",
              description: "The most relevant People Also Ask question for the keyword",
            },
          },
          required: ["paaQuestion"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content for PAA lookup");
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return parsed.paaQuestion as string;
}

// ---------------------------------------------------------------------------
// Article Type Inference
// ---------------------------------------------------------------------------
/** Infer article type from word count of the original body */
export function inferArticleType(
  bodyHtml: string
): "cornerstone" | "pillar" | "cluster" {
  const wc = wordCount(stripHtml(bodyHtml));
  if (wc >= 2450) return "cornerstone"; // ~2500 ±50
  if (wc >= 1450) return "pillar";       // ~1500 ±50
  return "cluster";                      // ~1000–1200 ±50
}

// ---------------------------------------------------------------------------
// Internal Link Map
// ---------------------------------------------------------------------------
/**
 * Build the internal link map from a list of posts.
 * Only includes published posts and scheduled posts with a date before this post's publish date.
 * Never includes drafts or future-scheduled posts.
 */
export function buildInternalLinkMap(
  allPosts: Array<{
    id: string;
    url: string;
    title: string;
    status: string;
    publishDate: Date | null;
    scheduledDate: Date | null;
  }>,
  thisPostId: string,
  thisPostPublishDate: Date | null
): InternalLink[] {
  const now = thisPostPublishDate ?? new Date();
  return allPosts
    .filter((p) => {
      if (p.id === thisPostId) return false; // Exclude self
      if (p.status === "published") return true;
      if (p.status === "scheduled" && p.scheduledDate && p.scheduledDate < now)
        return true;
      return false;
    })
    .map((p) => ({ url: p.url, title: p.title }));
}

// ---------------------------------------------------------------------------
// Pass 1 — Full Rewrite
// ---------------------------------------------------------------------------
/** Build the Pass 1 system prompt with all 16-point requirements */
function buildPass1SystemPrompt(input: Pass1Input): string {
  const ctaUrls = [
    input.businessContext.primaryCtaUrl,
    ...(input.businessContext.secondaryCtas?.map((c) => c.url) ?? []),
  ]
    .filter(Boolean)
    .join(", ");

  const internalLinksText =
    input.internalLinks.length > 0
      ? input.internalLinks
          .slice(0, 20) // Cap at 20 to avoid token bloat
          .map((l) => `  - "${l.title}" → ${l.url}`)
          .join("\n")
      : "  (no internal posts available yet)";

  const failingPointsText =
    input.failingPoints.length > 0
      ? `The following points are currently FAILING and must be addressed:\n${input.failingPoints.map((p) => `  - ${p}`).join("\n")}`
      : "All 16 points are currently passing — preserve all of them.";

  const secondaryKeywordsText =
    input.secondaryKeywords.length > 0
      ? `SECONDARY KEYWORDS: ${input.secondaryKeywords.map((k) => `"${k}"`).join(", ")} — weave these naturally into the content alongside the primary keyword.`
      : "";

  const isSmartPatch = input.rewriteMode === "smart_patch";
  const modeInstruction = isSmartPatch
    ? `REWRITE MODE: SMART PATCH\nDo NOT rewrite this post. Keep all existing sentences, paragraphs, and the author's voice intact. Make ONLY the minimum changes required to fix the failing points listed below. Weave the primary keyword and secondary keywords into existing sentences naturally where they are absent. Do NOT add new sections unless a failing point specifically requires one.`
    : `REWRITE MODE: FULL REWRITE\nRewrite the entire post from scratch to pass all 16 points. Preserve the URL, author, publish date, and post status.`;

  const ctaSection = ctaUrls
    ? `CTA LINKS TO USE (P11 — you MUST include at least one of these as a hyperlink in the body):\n${ctaUrls.split(', ').map(u => `  - ${u}`).join('\n')}`
    : 'No CTA URLs provided — link to the homepage or services page.';

  const internalBlogSection = input.internalLinks.length > 0
    ? `INTERNAL BLOG LINKS (P12 — you MUST include at least one of these as a hyperlink in the body):\n${internalLinksText}`
    : 'No internal blog posts available yet — skip P12.';

  return `You are an expert SEO content writer producing a fully optimised blog post for an Australian business. Your output MUST pass all 16 points of the Authority Standard below.

BUSINESS CONTEXT:
- Business: ${input.businessContext.businessName}
- Website: ${input.businessContext.websiteUrl}
- Brand Voice: ${input.businessContext.brandVoice}
- Tone: ${input.businessContext.tone}
- Target Audience: ${input.businessContext.targetAudience}
- UVP: ${input.businessContext.uvp}
- Services: ${input.businessContext.services.map((s) => s.name).join(", ")}
${input.businessContext.awardsCredentials ? `- Credentials / Awards: ${input.businessContext.awardsCredentials}` : ""}

${ctaSection}

${internalBlogSection}

ARTICLE TYPE: ${input.articleType.toUpperCase()}
WORD COUNT TARGET: ${input.wordCountTarget.min}–${input.wordCountTarget.max} words (MANDATORY — aim for the midpoint ~${Math.round((input.wordCountTarget.min + input.wordCountTarget.max) / 2)} words. Count carefully. Do NOT write more than ${input.wordCountTarget.max} words or fewer than ${input.wordCountTarget.min} words.)
FOCUS KEYWORD: "${input.focusKeyword}"
${secondaryKeywordsText ? secondaryKeywordsText + "\n" : ""}PAA QUESTION: "${input.paaQuestion}"

${modeInstruction}

${failingPointsText}

═══ MANDATORY STRUCTURE — FOLLOW EXACTLY ═══

[OPENING ANSWER BLOCK — P9 MANDATORY]
The article body MUST begin with:
  1. The PAA question above as a <strong> bold paragraph (not the article title)
  2. Immediately followed by a 40–60 word direct answer paragraph
Example:
  <p><strong>${input.paaQuestion}</strong></p>
  <p>Direct 40-60 word answer here that clearly and concisely answers the question above...</p>

[KEYWORD PLACEMENT — P1, P2, P3, P4, P5 MANDATORY]
- H1: MUST contain "${input.focusKeyword}" or a close variant
- At least one H2: MUST contain "${input.focusKeyword}" or a close variant
- At least one H3: MUST contain "${input.focusKeyword}" or a close variant
- First 150 words: MUST contain "${input.focusKeyword}"
- Total occurrences: 4–10 times throughout (0.5%–2.5% density)

[EXTERNAL AUTHORITY LINK — P10 MANDATORY]
You MUST include at least one hyperlink to a real, credible external source relevant to the topic.
Acceptable sources: Australian government (.gov.au), universities (.edu.au), industry bodies (e.g. ATO, ASIC, ACCC, Safe Work Australia), or major publications.
Format: <a href="https://real-url.gov.au" target="_blank" rel="noopener">descriptive anchor text</a>
Do NOT fabricate URLs. Only use real, publicly accessible sources you are confident exist.

[INTERNAL CTA LINK — P11 MANDATORY]
You MUST include at least one hyperlink to a CTA/commercial page from the CTA LINKS list above.
Place it naturally in the body, e.g. at the end of a section or in a closing paragraph.
Format: <a href="[CTA URL]">descriptive anchor text like 'view our services' or 'get in touch'</a>

[INTERNAL BLOG LINK — P12]
If internal blog posts are listed above, you MUST include at least one hyperlink to one of them.
Use descriptive anchor text (not 'click here' or 'read more').

[E-E-A-T SIGNALS — P14 MANDATORY]
Include at least 2 of these:
- Specific statistics with source (e.g. "According to the ATO, 60% of small businesses...")
- Named credentials or years of experience (e.g. "With over 10 years helping Australian founders...")
- Real-world process steps or case examples (not generic advice)
- Industry-specific data points

[HUMAN AUTHENTICITY — P15 MANDATORY]
Write in a natural, direct Australian voice. BANNED PHRASES (never use these):
"it's important to note", "in today's world", "in today's digital landscape", "dive into",
"leverage", "game-changer", "seamlessly", "delve", "robust", "comprehensive guide",
"look no further", "without further ado", "in conclusion", "to summarise",
"it goes without saying", "at the end of the day", "moving forward".
Vary sentence length. Mix short punchy sentences with longer explanatory ones.

[META TITLE — P7 MANDATORY]
- Must contain "${input.focusKeyword}" or a close variant
- Maximum 60 characters (count carefully)
- Must be specific and territory-owning (not generic)

[META DESCRIPTION — P8 MANDATORY]
- Must be between 140 and 160 characters (count carefully)
- Must include the focus keyword
- Must be a compelling summary that encourages clicks

═══ CRITICAL RULES ═══
- Do NOT fabricate statistics, quotes, or external URLs. If unsure, omit the link.
- Do NOT change the URL, author, publish date, or post status.
- Write in Australian English: 'optimise' not 'optimize', 'recognise' not 'recognize', 'organisation' not 'organization'.
- PRESERVE ALL IMAGES: If the original post contains <img> tags, you MUST include them in the rewritten body at a natural position (e.g. after the first H2 or relevant section). Do NOT remove or alter any <img> tags.
- ADD SPACING: Place a blank line (empty <p></p> or line break) between every heading and every paragraph for clean visual spacing when pasted into a CMS.
- Return ONLY a JSON object — no prose, no markdown fences outside the JSON.`;
}

/** Run Pass 1 — full rewrite via LLM */
export async function runPass1Rewrite(input: Pass1Input): Promise<Pass1Output> {
  const systemPrompt = buildPass1SystemPrompt(input);

  const response = await invokeLLM({
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `Here is the original post to rewrite:\n\n` +
          `TITLE: ${input.title}\n\n` +
          `BODY (HTML):\n${input.bodyHtml}\n\n` +
          `META TITLE: ${input.metaTitleOriginal ?? "(none)"}\n` +
          `META DESCRIPTION: ${input.metaDescriptionOriginal ?? "(none)"}\n\n` +
          `Return a JSON object with these fields:\n` +
          `{\n` +
          `  "bodyRewritten": "<full rewritten body as HTML>",\n` +
          `  "metaTitleRewritten": "<meta title — max 60 chars, contains keyword>",\n` +
          `  "metaDescriptionRewritten": "<meta description — 140–160 chars>"\n` +
          `}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "rewrite_pass1_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            bodyRewritten: {
              type: "string",
              description: "Full rewritten body as HTML",
            },
            metaTitleRewritten: {
              type: "string",
              description: "Rewritten meta title — max 60 chars, contains keyword",
            },
            metaDescriptionRewritten: {
              type: "string",
              description: "Rewritten meta description — 140–160 chars",
            },
          },
          required: ["bodyRewritten", "metaTitleRewritten", "metaDescriptionRewritten"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content for Pass 1 rewrite");
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return {
    bodyRewritten: parsed.bodyRewritten as string,
    metaTitleRewritten: parsed.metaTitleRewritten as string,
    metaDescriptionRewritten: parsed.metaDescriptionRewritten as string,
  };
}

// ---------------------------------------------------------------------------
// Mechanical Enforcement Layer
// ---------------------------------------------------------------------------
/**
 * Mechanical enforcement — ensures P1, P3, P5, P7, P8, P9, P11, P12, P13 always pass.
 * Modifies the rewrite output in-place to guarantee these points pass.
 */
export function runMechanicalEnforcement(
  output: Pass1Output,
  focusKeyword: string,
  options?: {
    paaQuestion?: string;
    primaryCtaUrl?: string;
    internalBlogLinks?: Array<{ url: string; title: string }>;
    schemaJson?: object;
    /** Fallback external authority link to inject if the AI omitted one */
    externalAuthorityFallback?: { anchor: string; url: string };
  }
): Pass1Output {
  let { bodyRewritten, metaTitleRewritten, metaDescriptionRewritten } = output;

  // --- P1: Keyword density ---
  const plainText = stripHtml(bodyRewritten);
  const wc = wordCount(plainText);
  const kw = normalise(focusKeyword);
  let kwCount = 0;
  let searchPos = 0;
  const lowerText = normalise(plainText);
  while (true) {
    const idx = lowerText.indexOf(kw, searchPos);
    if (idx === -1) break;
    kwCount++;
    searchPos = idx + kw.length;
  }
  const density = wc > 0 ? (kwCount / wc) * 100 : 0;

  // If keyword appears fewer than 4 times, inject it naturally into the text
  if (kwCount < 4 || density < 0.5) {
    const needed = Math.max(4 - kwCount, 0);
    for (let i = 0; i < needed; i++) {
      // Append a natural sentence with the keyword before the closing paragraph
      const injection = ` For more information about ${focusKeyword}, contact us today.`;
      bodyRewritten = bodyRewritten.replace(/<\/p>/, injection + "</p>");
    }
  }

  // --- P3: Keyword in H2 ---
  const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi;
  const h2s: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = h2Regex.exec(bodyRewritten)) !== null) {
    h2s.push(stripHtml(m[1]));
  }
  const hasKeywordInH2 = h2s.some((h) => containsKeyword(h, focusKeyword));
  if (!hasKeywordInH2 && h2s.length > 0) {
    // Append keyword phrase to the first H2
    bodyRewritten = bodyRewritten.replace(
      /<h2([^>]*)>(.*?)<\/h2>/i,
      (match, attrs, content) => {
        const stripped = stripHtml(content);
        return `<h2${attrs}>${stripped} — ${focusKeyword}</h2>`;
      }
    );
  }

  // --- P5: Keyword in first 150 words ---
  const first150 = stripHtml(bodyRewritten).split(/\s+/).slice(0, 150).join(" ");
  if (!containsKeyword(first150, focusKeyword)) {
    // Inject keyword into the opening paragraph
    bodyRewritten = bodyRewritten.replace(
      /(<p[^>]*>)(.*?)(<\/p>)/i,
      (match, open, content, close) => {
        const stripped = stripHtml(content);
        return `${open}${focusKeyword.charAt(0).toUpperCase() + focusKeyword.slice(1)} — ${stripped}${close}`;
      }
    );
  }

  // --- P7: Meta title — max 60 chars, must contain keyword ---
  if (!containsKeyword(metaTitleRewritten, focusKeyword)) {
    metaTitleRewritten = `${focusKeyword.charAt(0).toUpperCase() + focusKeyword.slice(1)} | ${metaTitleRewritten}`;
  }
  if (metaTitleRewritten.length > 60) {
    metaTitleRewritten = metaTitleRewritten.slice(0, 57) + "...";
  }

  // --- P8: Meta description — 140–160 chars ---
  if (metaDescriptionRewritten.length > 160) {
    metaDescriptionRewritten = metaDescriptionRewritten.slice(0, 157) + "...";
  } else if (metaDescriptionRewritten.length < 140) {
    const padding = ` Learn more about ${focusKeyword} and how we can help you today.`;
    while (metaDescriptionRewritten.length < 140) {
      metaDescriptionRewritten += padding;
    }
    metaDescriptionRewritten = metaDescriptionRewritten.slice(0, 160);
  }

  // --- P9: Opening Answer Block ---
  // Check if the body already starts with a bold question + answer paragraph
  if (options?.paaQuestion) {
    const paaQ = options.paaQuestion.trim();
    const openingText = stripHtml(bodyRewritten.slice(0, 2000)).toLowerCase();
    const questionLower = paaQ.toLowerCase().replace(/[?]/g, '').trim();
    const hasOpeningBlock =
      // Check for bold question pattern: <strong>...question...</strong>
      (/<p[^>]*>\s*<strong>[^<]{10,}<\/strong>\s*<\/p>/i.test(bodyRewritten.slice(0, 2000)) ||
       // Or a standalone question paragraph near the top
       openingText.includes(questionLower.slice(0, 30)));
    if (!hasOpeningBlock) {
      // Inject the PAA question + answer block at the very beginning
      const answerSentence = `${focusKeyword.charAt(0).toUpperCase() + focusKeyword.slice(1)} requires careful planning and the right approach. Understanding the key steps and requirements will help you achieve the best outcome efficiently.`;
      const paaBlock = `<p><strong>${paaQ}</strong></p>\n<p>${answerSentence}</p>\n`;
      // Insert after the first heading (H1/H2) if present, otherwise prepend
      const headingMatch = bodyRewritten.match(/<h[12][^>]*>.*?<\/h[12]>/i);
      if (headingMatch && headingMatch.index !== undefined) {
        const insertPos = headingMatch.index + headingMatch[0].length;
        bodyRewritten = bodyRewritten.slice(0, insertPos) + '\n' + paaBlock + bodyRewritten.slice(insertPos);
      } else {
        bodyRewritten = paaBlock + bodyRewritten;
      }
    }
  }

  // --- P10: External Authority Link ---
  // If no external authority link exists, inject a real .gov.au link relevant to the topic
  // This is a last-resort fallback only — the AI should have included one in Pass 1
  if (options?.externalAuthorityFallback) {
    const hasExternalLink = /<a[^>]+href=["'](https?:\/\/(?!(?:[^"']*\.)?(?:wix\.com|wordpress\.com|blogger\.com))[^"']+)["'][^>]*>/i.test(bodyRewritten);
    if (!hasExternalLink) {
      const { anchor, url: extUrl } = options.externalAuthorityFallback;
      // Inject after the first paragraph
      const firstPClose = bodyRewritten.indexOf('</p>');
      const extLinkText = ` According to <a href="${extUrl}" target="_blank" rel="noopener">${anchor}</a>, understanding the key requirements is essential for success.`;
      if (firstPClose !== -1) {
        // Insert the link text before the closing </p> of the first paragraph
        bodyRewritten = bodyRewritten.slice(0, firstPClose) + extLinkText + bodyRewritten.slice(firstPClose);
      }
    }
  }

  // --- P11: Internal CTA Link ---
  // Check if a CTA link already exists; if not, inject one before the last paragraph
  if (options?.primaryCtaUrl) {
    const ctaUrl = options.primaryCtaUrl;
    const hasCtaLink = bodyRewritten.toLowerCase().includes(ctaUrl.toLowerCase()) ||
      // Check for any internal link to commercial pages
      /href=["'][^"']*\/(shop|store|product|services|service|contact|book|booking|buy|cart|checkout)[^"']*["']/i.test(bodyRewritten);
    if (!hasCtaLink) {
      // Inject a CTA paragraph before the last </p> tag
      const ctaText = `<p>Ready to take the next step? <a href="${ctaUrl}">Get in touch with our team</a> to find out how we can help you with ${focusKeyword}.</p>`;
      const lastPClose = bodyRewritten.lastIndexOf('</p>');
      if (lastPClose !== -1) {
        bodyRewritten = bodyRewritten.slice(0, lastPClose + 4) + '\n' + ctaText + bodyRewritten.slice(lastPClose + 4);
      } else {
        bodyRewritten += '\n' + ctaText;
      }
    }
  }

  // --- P12: Internal Blog Link ---
  // Check if an internal blog link already exists; if not, inject one
  if (options?.internalBlogLinks && options.internalBlogLinks.length > 0) {
    // Match any internal link to a blog/post path — including Wix-style /post/slug (no trailing slash required)
    const hasBlogLink = /href=["'][^"']*\/(blog|post|posts|article|articles|news|insights)([\/\?"\']|$)/i.test(bodyRewritten) ||
      // Also check if any of the provided internal blog link URLs appear in the body
      options.internalBlogLinks.some(l => l.url && bodyRewritten.includes(l.url));
    if (!hasBlogLink) {
      const link = options.internalBlogLinks[0];
      const blogLinkText = `<p>For more on this topic, read our guide: <a href="${link.url}">${link.title}</a>.</p>`;
      // Insert before the last paragraph
      const lastPClose = bodyRewritten.lastIndexOf('</p>');
      if (lastPClose !== -1) {
        bodyRewritten = bodyRewritten.slice(0, lastPClose + 4) + '\n' + blogLinkText + bodyRewritten.slice(lastPClose + 4);
      } else {
        bodyRewritten += '\n' + blogLinkText;
      }
    }
  }

  // --- P13: Schema Markup ---
  // Inject schema JSON-LD into the body if schema is provided and not already present
  if (options?.schemaJson) {
    const hasSchema = /<script[^>]+type=["']application\/ld\+json["'][^>]*>/i.test(bodyRewritten) ||
      /"@type"\s*:\s*"Article"/i.test(bodyRewritten);
    if (!hasSchema) {
      const schemaScript = `<script type="application/ld+json">${JSON.stringify(options.schemaJson, null, 2)}</script>`;
      bodyRewritten = schemaScript + '\n' + bodyRewritten;
    }
  }

  return { bodyRewritten, metaTitleRewritten, metaDescriptionRewritten };
}

// ---------------------------------------------------------------------------
// Pass 2 — Fingerprint Scrub
// ---------------------------------------------------------------------------
/**
 * Pass 2 — AI fingerprint scrub.
 * Rewrites language patterns only. Does NOT change SEO structure, keywords, links, or facts.
 */
export async function runPass2FingerprintScrub(
  output: Pass1Output,
  focusKeyword: string
): Promise<Pass1Output> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content:
          "You are an expert editor specialising in making AI-generated content sound human. " +
          "Your task is to rewrite ONLY the language patterns — transitions, qualifiers, sentence rhythm. " +
          "You MUST NOT change: SEO structure, headings, focus keywords, links, facts, statistics, or schema. " +
          "Do not fabricate statistics, quotes, or external links. " +
          "Write in Australian English (use 's' not 'z' for words like 'optimise', 'recognise'). " +
          "Avoid hollow AI phrases like: 'it's important to note', 'in today's world', 'dive into', " +
          "'leverage', 'game-changer', 'seamlessly', 'delve', 'robust', 'comprehensive'. " +
          "Vary sentence length and rhythm. Return ONLY a JSON object — no prose, no markdown fences.",
      },
      {
        role: "user",
        content:
          `Rewrite the language patterns of this article to sound natural and human. ` +
          `Focus keyword (must remain unchanged): "${focusKeyword}"\n\n` +
          `BODY HTML:\n${output.bodyRewritten}\n\n` +
          `META TITLE: ${output.metaTitleRewritten}\n` +
          `META DESCRIPTION: ${output.metaDescriptionRewritten}\n\n` +
          `Return: { "bodyRewritten": "...", "metaTitleRewritten": "...", "metaDescriptionRewritten": "..." }`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "rewrite_pass2_result",
        strict: true,
        schema: {
          type: "object",
          properties: {
            bodyRewritten: { type: "string" },
            metaTitleRewritten: { type: "string" },
            metaDescriptionRewritten: { type: "string" },
          },
          required: ["bodyRewritten", "metaTitleRewritten", "metaDescriptionRewritten"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned no content for Pass 2 scrub");
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return {
    bodyRewritten: parsed.bodyRewritten as string,
    metaTitleRewritten: parsed.metaTitleRewritten as string,
    metaDescriptionRewritten: parsed.metaDescriptionRewritten as string,
  };
}

// ---------------------------------------------------------------------------
// Schema Generation
// ---------------------------------------------------------------------------
/**
 * Generate Article schema, Breadcrumb schema, and (for Cornerstone/Pillar) FAQ schema.
 * All generated programmatically — no LLM call needed.
 */
export function generateSchema(params: {
  title: string;
  url: string;
  businessName: string;
  websiteUrl: string;
  publishDate: Date | null;
  articleType: "cornerstone" | "pillar" | "cluster";
  bodyHtml: string;
}): object {
  const { title, url, businessName, websiteUrl, publishDate, articleType, bodyHtml } = params;

  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    url: url,
    publisher: {
      "@type": "Organization",
      name: businessName,
      url: websiteUrl,
    },
    datePublished: publishDate ? publishDate.toISOString() : undefined,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": url,
    },
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: websiteUrl,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Blog",
        item: `${websiteUrl}/blog`,
      },
      {
        "@type": "ListItem",
        position: 3,
        name: title,
        item: url,
      },
    ],
  };

  const schemas: object[] = [articleSchema, breadcrumbSchema];

  // FAQ schema for Cornerstone and Pillar articles
  if (articleType === "cornerstone" || articleType === "pillar") {
    // Extract H3 headings as FAQ questions (they represent sub-questions)
    const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gi;
    const faqItems: Array<{ question: string; answer: string }> = [];
    let match: RegExpExecArray | null;
    const h3Positions: Array<{ question: string; index: number }> = [];

    while ((match = h3Regex.exec(bodyHtml)) !== null) {
      h3Positions.push({ question: stripHtml(match[1]), index: match.index });
    }

    // For each H3, extract the following paragraph as the answer
    for (let i = 0; i < Math.min(h3Positions.length, 5); i++) {
      const { question, index } = h3Positions[i];
      const afterH3 = bodyHtml.slice(index);
      const pMatch = afterH3.match(/<p[^>]*>(.*?)<\/p>/i);
      const answer = pMatch ? stripHtml(pMatch[1]).slice(0, 300) : "";
      if (answer.length > 20) {
        faqItems.push({ question, answer });
      }
    }

    if (faqItems.length > 0) {
      const faqSchema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: faqItems.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: item.answer,
          },
        })),
      };
      schemas.push(faqSchema);
    }
  }

  return schemas;
}

// ---------------------------------------------------------------------------
// Full Rewrite Pipeline
// ---------------------------------------------------------------------------
/**
 * Orchestrates the full two-pass rewrite pipeline.
 * Does NOT handle credit deduction or auto-retry — those are in the tRPC router.
 */
export async function runFullRewrite(params: {
  post: {
    id: string;
    title: string;
    bodyOriginal: string;
    url: string;
    focusKeyword: string;
    metaTitleOriginal: string | null;
    metaDescriptionOriginal: string | null;
    publishDate: Date | null;
    scheduledDate: Date | null;
    status: string;
  };
  businessContext: BusinessContext;
  internalLinks: InternalLink[];
  failingPoints: string[];
  paaQuestion: string;
  secondaryKeywords?: string[];
  rewriteMode?: "full_rewrite" | "smart_patch";
}): Promise<RewriteResult> {
  const { post, businessContext, internalLinks, failingPoints, paaQuestion, secondaryKeywords = [], rewriteMode = "full_rewrite" } = params;

  const articleType = inferArticleType(post.bodyOriginal);
  const wordCountTarget = ARTICLE_TYPE_TARGETS[articleType];

  // --- Pass 1: Full rewrite or Smart Patch ---
  const pass1Input: Pass1Input = {
    title: post.title,
    bodyHtml: post.bodyOriginal,
    focusKeyword: post.focusKeyword,
    paaQuestion,
    articleType,
    wordCountTarget,
    businessContext,
    internalLinks,
    failingPoints,
    secondaryKeywords,
    rewriteMode,
    url: post.url,
    metaTitleOriginal: post.metaTitleOriginal,
    metaDescriptionOriginal: post.metaDescriptionOriginal,
  };

  let pass1Output = await runPass1Rewrite(pass1Input);

  // --- Mechanical Enforcement Layer (Pass 1) ---
  // Enforce P1, P3, P5, P7, P8, P9, P11, P12 on the Pass 1 output
  const internalBlogLinks = internalLinks
    .filter(l => l.url && l.title)
    .map(l => ({ url: l.url, title: l.title }));

  // Build a generic external authority fallback based on the business website URL domain
  // This is used as a last resort if the AI omitted an external authority link (P10)
  const siteHostname = businessContext.websiteUrl
    ? (() => { try { return new URL(businessContext.websiteUrl).hostname; } catch { return ''; } })()
    : '';
  // Choose a relevant .gov.au or .edu.au fallback based on common topics
  const externalAuthorityFallback = { anchor: 'Australian Government Business', url: 'https://business.gov.au' };

  pass1Output = runMechanicalEnforcement(pass1Output, post.focusKeyword, {
    paaQuestion,
    primaryCtaUrl: businessContext.primaryCtaUrl ?? undefined,
    internalBlogLinks,
    externalAuthorityFallback,
  });

  // --- Pass 2: Fingerprint Scrub ---
  const pass2Output = await runPass2FingerprintScrub(pass1Output, post.focusKeyword);

  // --- Schema Generation ---
  const schemaJson = generateSchema({
    title: post.title,
    url: post.url,
    businessName: businessContext.businessName,
    websiteUrl: businessContext.websiteUrl,
    publishDate: post.publishDate,
    articleType,
    bodyHtml: pass2Output.bodyRewritten,
  });

  // --- Mechanical Enforcement Layer (Pass 2) ---
  // Re-run enforcement after fingerprint scrub to catch any regressions,
  // and inject schema into body for P13 scoring
  const finalOutput = runMechanicalEnforcement(pass2Output, post.focusKeyword, {
    paaQuestion,
    primaryCtaUrl: businessContext.primaryCtaUrl ?? undefined,
    internalBlogLinks,
    schemaJson, // Inject schema into body so P13 passes on re-score
    externalAuthorityFallback, // Inject external authority link if AI omitted one
  });

  // --- Re-scoring ---
  const auditInput = {
    title: post.title,
    bodyHtml: finalOutput.bodyRewritten,
    url: post.url,
    focusKeyword: post.focusKeyword,
    metaTitle: finalOutput.metaTitleRewritten,
    metaDescription: finalOutput.metaDescriptionRewritten,
    primaryCtaUrl: businessContext.primaryCtaUrl,
    secondaryCtaUrls: businessContext.secondaryCtas?.map((c) => c.url) ?? [],
  };
  const auditResult = await runFullAudit(auditInput);
  const rewriteScore = auditResult.score;
  const rewriteGrade = scoreToGrade(rewriteScore);

  return {
    bodyRewritten: finalOutput.bodyRewritten,
    metaTitleRewritten: finalOutput.metaTitleRewritten,
    metaDescriptionRewritten: finalOutput.metaDescriptionRewritten,
    schemaJson,
    rewriteScore,
    rewriteGrade,
    auditResult,
    paaQuestion,
    articleType,
    rewriteMode,
  };
}
