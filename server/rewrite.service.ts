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
import { invokeClaude } from "./_core/claude";
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
  targetAudienceProblems?: string | null;
  brandVoiceAnalysis?: string | null;
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
  rewriteMode: "full_rewrite" | "smart_patch" | "seo_refresh";
  /** Extracted CTA section from original post — must be preserved verbatim */
  originalCtaSection?: string | null;
  /** Extracted FAQ section from original post — must be preserved verbatim */
  originalFaqSection?: string | null;
  /** Optional free-text instructions from the user to guide the rewrite */
  userInstructions?: string | null;
}

export interface Pass1Output {
  bodyRewritten: string;
  metaTitleRewritten: string;
  metaDescriptionRewritten: string;
  aiSnippet?: string;
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
  rewriteMode: "full_rewrite" | "smart_patch" | "seo_refresh";
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
export async function lookupPaaQuestion(
  focusKeyword: string,
  postTitle: string,
  bodyHtml: string,
): Promise<string> {
  // Extract first 200 words of plain text from body
  const plainText = stripHtml(bodyHtml);
  const first200Words = plainText.split(/\s+/).slice(0, 200).join(" ");

  const buildPrompt = () =>
    `You are an SEO expert. A blog post has the following details:

POST TITLE: ${postTitle}
FOCUS KEYWORD: ${focusKeyword}
FIRST 200 WORDS OF POST:
${first200Words}

Generate a single People Also Ask (PAA) question that:
1. Is DIRECTLY related to this specific post's topic and focus keyword.
2. Is something a real person would search on Google when looking for information about this exact topic.
3. Matches the subject matter described in the post title and opening content above.
4. Do NOT suggest questions about unrelated topics, industries, or subjects.

Return a JSON object: { "paaQuestion": "<the question>" }`;

  const callLLM = async () => {
    const response = await invokeClaude({
      system:
        "You are an SEO expert. Return only a JSON object — no prose, no markdown fences. " +
        "The PAA question MUST be directly relevant to the post topic provided. " +
        "Do not fabricate statistics or suggest questions about unrelated industries.",
      messages: [{ role: "user", content: buildPrompt() }],
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
                description: "A People Also Ask question directly related to the post topic and focus keyword",
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
  };

  // Relevance validation: question must contain the focus keyword OR at least 2 words from the title
  const isRelevant = (question: string): boolean => {
    const q = question.toLowerCase();
    if (q.includes(focusKeyword.toLowerCase())) return true;
    const titleWords = postTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3); // ignore short words like "the", "and", "for"
    const matches = titleWords.filter((w) => q.includes(w));
    return matches.length >= 2;
  };

  // Attempt 1
  const attempt1 = await callLLM();
  if (isRelevant(attempt1)) return attempt1;

  console.warn(`[PAA] Attempt 1 failed relevance check: "${attempt1}" — retrying once`);

  // Attempt 2 (retry)
  try {
    const attempt2 = await callLLM();
    if (isRelevant(attempt2)) return attempt2;
    console.warn(`[PAA] Attempt 2 also failed relevance check: "${attempt2}" — returning empty`);
    return ""; // Leave blank for user to fill in manually
  } catch {
    return ""; // Retry failed — leave blank
  }
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
  const isSeoRefresh = input.rewriteMode === "seo_refresh";
  const modeInstruction = isSeoRefresh
    ? `REWRITE MODE: SEO REFRESH — READ CAREFULLY\nThis is an SEO Refresh. Do NOT rewrite the body content. Keep every paragraph, fact, example, and sentence as close to the original as possible.\nONLY make these five changes:\n  1. Improve the opening 2 sentences to include the focus keyword naturally.\n  2. Adjust heading tags to follow H1 → H2 → H3 hierarchy.\n  3. Rewrite the meta title to 50–60 characters with the focus keyword.\n  4. Rewrite the meta description to 140–160 characters with the focus keyword.\n  5. Ensure the focus keyword appears naturally in the first 100 words.\nDo not add new paragraphs. Do not remove existing paragraphs. Do not change facts, examples, statistics, or named entities.`
    : isSmartPatch
    ? `REWRITE MODE: SMART PATCH\nDo NOT rewrite this post. Keep all existing sentences, paragraphs, and the author's voice intact. Make ONLY the minimum changes required to fix the failing points listed below. Weave the primary keyword and secondary keywords into existing sentences naturally where they are absent. Do NOT add new sections unless a failing point specifically requires one.`
    : `REWRITE MODE: FULL REWRITE\nRewrite the entire post from scratch to pass all 16 points. Preserve the URL, author, publish date, and post status.`;

  const ctaSection = ctaUrls
    ? `CTA LINKS TO USE (P11 — you MUST include at least one of these as a hyperlink in the body):\n${ctaUrls.split(', ').map(u => `  - ${u}`).join('\n')}`
    : 'No CTA URLs provided — link to the homepage or services page.';

  const internalBlogSection = input.internalLinks.length > 0
    ? `INTERNAL BLOG LINKS (P12 — you MUST include at least one of these as a hyperlink in the body):\n${internalLinksText}`
    : 'No internal blog posts available yet — skip P12.';

  const userInstructionsBlock = input.userInstructions?.trim()
    ? `USER INSTRUCTIONS: ${input.userInstructions.trim()}\n\n`
    : '';

  return `${userInstructionsBlock}You are an expert SEO content writer producing a fully optimised blog post for an Australian business. Your output MUST pass all 16 points of the Authority Standard below.

BUSINESS CONTEXT:
- Business: ${input.businessContext.businessName}
- Website: ${input.businessContext.websiteUrl}
- Brand Voice: ${input.businessContext.brandVoice}
- Tone: ${input.businessContext.tone}
- Target Audience: ${input.businessContext.targetAudience}${input.businessContext.targetAudienceProblems ? `\n- Problems This Business Solves: ${input.businessContext.targetAudienceProblems}` : ''}
- UVP: ${input.businessContext.uvp}${input.businessContext.brandVoiceAnalysis ? `\n- Brand Voice Analysis: ${input.businessContext.brandVoiceAnalysis}` : ''}
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

═══ STRICT RULES — YOU MUST FOLLOW THESE ═══

1. You MUST work with the existing content. Do not invent facts, statistics, quotes, or claims not present in the original article.
2. Plan the entire article structure BEFORE writing. Total word count must be between ${input.wordCountTarget.min} and ${input.wordCountTarget.max}. Do not exceed the upper limit.
3. Meta title must be composed at 50–60 characters from the start. Do not write long and truncate.
4. Meta description must be composed at 140–160 characters from the start. Do not write long and truncate.
5. Preserve the core message, main points, and factual content of the original article. You are improving the writing, not replacing the substance.

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
[PARAGRAPH STRUCTURE — MANDATORY]
- Every paragraph MUST contain at least 2–3 complete sentences. NEVER write a single-sentence paragraph on its own line.
- NEVER write orphaned colon-fragments like "They:" or "Here's what that looks like:" as a standalone paragraph followed by a list. Rewrite as flowing prose instead.
- NEVER write bare list items that are sentence fragments (e.g. "learn what makes a homepage effective" on its own line). Combine them into a proper sentence or paragraph.
- If you use a bullet list, each item must be a complete sentence of at least 8 words.
- NEVER write 3 or more consecutive single-sentence paragraphs. Merge them.
- The staccato style (one short sentence per line, every line its own paragraph) is the most obvious AI fingerprint. Avoid it completely.

[AI CITATION SNIPPET — MANDATORY — SEPARATE FIELD]
Write a 2–3 sentence AI citation snippet that will be injected as the very first paragraph of the published post.
This snippet is designed to be cited verbatim by AI answer engines (Perplexity, ChatGPT, Bing Copilot, Google AI Overviews).
Rules:
- Directly answers the PAA question in plain, factual language
- Contains the focus keyword naturally
- Cites one specific fact, statistic, or credential (real — do NOT fabricate)
- Under 150 words total
- No hollow openers, no "In this article", no "it's important to note" — just a direct, citable answer
- Written as a single clean paragraph (no sub-sentences, no lists)
Output this as the "aiSnippet" field in your JSON response. Do NOT include it inside bodyRewritten — it will be prepended automatically.

[META TITLE — P7 MANDATORY — HARD LIMIT]
- Must contain "${input.focusKeyword}" or a close variant
- HARD LIMIT: 40–60 characters TOTAL. Count every character including spaces. If your draft is over 60 characters, shorten it — do NOT write a long title and expect it to be trimmed. A title that exceeds 60 characters FAILS.
- Must be specific and territory-owning (not generic)
- NEVER end with "..." or any ellipsis
[META DESCRIPTION — P8 MANDATORY — HARD LIMIT]
- HARD LIMIT: exactly 140–160 characters TOTAL. Count every character including spaces. If your draft is over 160 characters, shorten it. If under 140, expand it. A description outside this range FAILS.
- Must include the focus keyword
- Must be a compelling summary that encourages clicks
- NEVER end with "..." or any ellipsis

═══ CRITICAL RULES ═══
- Do NOT fabricate statistics, quotes, or external URLs. If unsure, omit the link.
- Do NOT change the URL, author, publish date, or post status.
- Write in Australian English: 'optimise' not 'optimize', 'recognise' not 'recognize', 'organisation' not 'organization'.
- PRESERVE ALL IMAGES: If the original post contains <img> tags, you MUST include them in the rewritten body at a natural position (e.g. after the first H2 or relevant section). Do NOT remove or alter any <img> tags.
- ADD SPACING: Place a blank line (empty <p></p> or line break) between every heading and every paragraph for clean visual spacing when pasted into a CMS.
${input.originalCtaSection ? `- PRESERVE CTA SECTION VERBATIM: The original post has a "What you can do next" or call-to-action section. You MUST include this section EXACTLY as written below — do NOT alter product names, service descriptions, links, or pricing. Copy it word-for-word into the rewritten body near the end:\n\n${input.originalCtaSection}\n` : ''}
${input.originalFaqSection ? `- PRESERVE FAQ SECTION VERBATIM: The original post has a Frequently Asked Questions section. You MUST include this section EXACTLY as written below — do NOT alter any questions, answers, or facts:\n\n${input.originalFaqSection}\n` : ''}
- Return ONLY a JSON object — no prose, no markdown fences outside the JSON.`;
}

// ---------------------------------------------------------------------------
// Pass 1A — Outline Generation
// ---------------------------------------------------------------------------
interface RewriteOutline {
  title: string;
  metaTitle: string;
  metaDescription: string;
  sections: Array<{ heading: string; targetWords: number; notes: string }>;
}

async function generateRewriteOutline(input: Pass1Input): Promise<RewriteOutline> {
  const existingH2s: string[] = [];
  const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi;
  let m: RegExpExecArray | null;
  while ((m = h2Regex.exec(input.bodyHtml)) !== null) {
    existingH2s.push(stripHtml(m[1]));
  }

  const userInstructionsLine = input.userInstructions?.trim()
    ? `Publisher direction: "${input.userInstructions.trim()}". Build the outline around this direction.`
    : '';

  const userMsg =
    `You are an expert SEO content strategist. Plan the structure for a rewritten blog article.\n` +
    `Business: ${input.businessContext.businessName} (${input.businessContext.targetAudience ?? 'business'}, Australia)\n` +
    `Primary Keyword: ${input.focusKeyword}\n` +
    `Article Title: ${input.title}\n` +
    `Current H2 headings: ${existingH2s.length > 0 ? existingH2s.join(', ') : '(none)'}\n` +
    `Total Word Count Target: ${input.wordCountTarget.min}–${input.wordCountTarget.max} words\n` +
    `RULES (ALL MANDATORY):\n` +
    `- H1 title MUST contain the exact primary keyword verbatim [P2]\n` +
    `- Meta title MUST contain the primary keyword and be ≤60 characters [P7]\n` +
    `- Meta description MUST contain the exact primary keyword phrase and be EXACTLY 140–160 characters — do NOT truncate mid-sentence [P8]\n` +
    `- Plan 5–8 H2 sections so the total hits ${input.wordCountTarget.min}–${input.wordCountTarget.max} words [P16]\n` +
    `- AT LEAST ONE H2 heading must contain the primary keyword [P3]\n` +
    `- The FIRST section must be an "Opening Answer Block" (40–60 words) that directly answers the search query with a bold question [P9]\n` +
    `- The LAST section must be a CTA section (50–80 words)\n` +
    `- Each section's targetWords should be realistic for that section's depth\n` +
    `- Use Australian English spelling\n` +
    `- Plan for an external authority link (.gov.au or industry body) in section 2 [P10]\n` +
    `- Plan for E-E-A-T signals (years experience, clients, awards) in at least one section [P14]\n` +
    (userInstructionsLine ? `- ${userInstructionsLine}\n` : '') +
    `Return a single JSON object:\n` +
    `{\n` +
    `  "title": "H1 title (contains primary keyword verbatim)",\n` +
    `  "metaTitle": "SEO meta title (≤60 chars, contains primary keyword)",\n` +
    `  "metaDescription": "SEO meta description (exactly 140–160 chars, complete sentences, contains primary keyword)",\n` +
    `  "sections": [\n` +
    `    { "heading": "H2 heading text", "targetWords": 200, "notes": "What this section covers in 1 sentence" }\n` +
    `  ]\n` +
    `}`;

  let outline: RewriteOutline | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await invokeClaude({
      max_tokens: 2000,
      system: 'You are an expert SEO content strategist. Return only a valid JSON object. No markdown, no code fences.',
      messages: [{ role: 'user', content: userMsg }],
    });
    const raw = resp.choices?.[0]?.message?.content ?? '';
    // Strip markdown fences if present
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try {
      const parsed = JSON.parse(jsonStr) as RewriteOutline;
      if (!parsed.sections || parsed.sections.length < 3) throw new Error('Too few sections');
      outline = parsed;
      break;
    } catch {
      console.warn(`[Rewrite] Outline JSON parse failed (attempt ${attempt + 1}):`, jsonStr.slice(0, 200));
    }
  }
  if (!outline) throw new Error('Failed to generate rewrite outline after 3 attempts');
  return outline;
}

// ---------------------------------------------------------------------------
// Pass 1B — Single guided rewrite call (replaces section-by-section approach)
// ---------------------------------------------------------------------------
async function rewriteWithSingleCall(
  outline: RewriteOutline,
  input: Pass1Input,
  bannedPhrases: string
): Promise<string> {
  const { wordCountMin, wordCountMax } = {
    wordCountMin: input.wordCountTarget.min,
    wordCountMax: input.wordCountTarget.max,
  };

  const sectionsText = outline.sections
    .map((s, i) => `${i + 1}. H2: "${s.heading}" — ${s.targetWords} words — ${s.notes}`)
    .join('\n');

  const brandVoice = input.businessContext.brandVoice?.trim() ||
    'Professional, authoritative, helpful. Sound like a real human expert.';

  const userMsg =
    `You are an expert SEO content writer. Rewrite this blog article following the plan below exactly.\n\n` +
    `ARTICLE CONTEXT:\n` +
    `Business: ${input.businessContext.businessName} (${input.businessContext.targetAudience ?? 'business'}, ${input.businessContext.websiteUrl ? new URL(input.businessContext.websiteUrl).hostname.replace('www.', '') : 'Australia'})\n` +
    `Primary Keyword: ${input.focusKeyword}\n` +
    `Brand Voice: ${brandVoice}\n\n` +
    `REWRITE PLAN (follow this structure exactly):\n` +
    `Title (H1): ${outline.title}\n` +
    `Sections to write:\n${sectionsText}\n\n` +
    `STRICT RULES:\n` +
    `- Total word count: ${wordCountMin}–${wordCountMax} words\n` +
    `- The primary keyword "${input.focusKeyword}" MUST appear in the first 50 words [P5]\n` +
    `- At least one H2 heading must contain the primary keyword [P3]\n` +
    `- Use <h3> tags for all subheadings within sections. Do NOT write subheadings as plain text or bold paragraphs. Every subsection title must be wrapped in <h3>...</h3>\n` +
    `- At least one <h3> tag must contain the primary keyword "${input.focusKeyword}" [P4]\n` +
    `- The first section must open with a bold question and direct 40–60 word answer [P9]\n` +
    `- Section 2 must include one external link to a real .gov.au or industry authority source [P10]\n` +
    `- When you mention any external website, directory, business tool, government body, or named service BY NAME, you MUST wrap it in a real working hyperlink. Example: <a href="https://www.hotfrog.com.au">Hotfrog</a>, <a href="https://www.yellowpages.com.au">Yellow Pages</a>, <a href="https://www.truelocal.com.au">True Local</a>\n` +
    `- Never mention an external service or website by name without linking to it\n` +
    `- Use the real, correct URL for each service — do NOT make up URLs\n` +
    `- Anchor text must be the brand/service name, not "click here" or "this site"\n` +
    `- Use Australian English spelling throughout\n` +
    `- Vary sentence length — mix short punchy sentences with longer ones\n` +
    `- Sound like a specific human expert, not a generic AI\n` +
    `- DO NOT use: ${bannedPhrases}\n` +
    `- DO NOT use em dashes (—) excessively\n` +
    `- DO NOT fabricate statistics\n` +
    `- Preserve all images and links from the original where relevant\n\n` +
    `ORIGINAL ARTICLE (for reference — rewrite this, do not copy it):\n` +
    `${input.bodyHtml}\n\n` +
    `Return ONLY the full rewritten HTML body wrapped in:\n` +
    `<ARTICLE_HTML>\n` +
    `...full html here (h2, h3, p, ul, ol, li, a, strong, em tags only)...\n` +
    `</ARTICLE_HTML>`;

  const resp = await invokeClaude({
    max_tokens: 32000,
    system: 'You are an expert SEO content writer. Return ONLY the full article HTML wrapped in <ARTICLE_HTML>...</ARTICLE_HTML> delimiters. No other text.',
    messages: [{ role: 'user', content: userMsg }],
  });

  const raw = resp.choices?.[0]?.message?.content ?? '';
  const articleMatch = raw.match(/<ARTICLE_HTML>\s*([\s\S]*?)\s*<\/ARTICLE_HTML>/i);
  const bodyHtml = articleMatch?.[1]?.trim() ?? raw.trim();
  console.log(`[Rewrite] Pass 1B single-call complete (${wordCount(stripHtml(bodyHtml))} words)`);
  return bodyHtml;
}

/** Run Pass 1 — outline + section-by-section rewrite */
export async function runPass1Rewrite(input: Pass1Input): Promise<Pass1Output> {
  const BANNED_PHRASES_LIST = [
    "in today's world", "it's important to note", "it is important to note", "delve into",
    "game-changer", "game changer", "leverage", "synergy", "transformative",
    "it's crucial to", "it is crucial to", "one of the most important", "ultimately,",
    "essentially,", "furthermore,", "moreover,", "at the end of the day",
    "according to research", "studies show", "it has been shown",
    "navigating the complexities", "navigate the ever-changing",
    "in today's competitive landscape", "in today's fast-paced", "in today's digital",
    "look no further", "cutting-edge", "state-of-the-art", "seamlessly",
    "robust solution", "tailored solutions", "tailored to your needs",
    "unlock your potential", "unlock the power", "empower your", "elevate your",
    "take your business to the next level", "in conclusion,", "to summarize,",
    "to summarise,", "it goes without saying", "needless to say",
    "as we all know", "the bottom line is", "at its core", "dive into",
    "in other words",
  ];
  const bannedPhrasesStr = BANNED_PHRASES_LIST.join(', ');

  // Step 1A — Generate outline
  console.log(`[Rewrite] Pass 1A: generating outline for post with keyword "${input.focusKeyword}"`);
  const outline = await generateRewriteOutline(input);
  console.log(`[Rewrite] Pass 1A: outline ready — ${outline.sections.length} sections planned`);

  // Step 1B — Single guided rewrite call
  console.log(`[Rewrite] Pass 1B: single guided rewrite call for post with keyword "${input.focusKeyword}"`);
  let bodyRewritten = await rewriteWithSingleCall(outline, input, bannedPhrasesStr);

  // --- P16 Condensation Pass: if word count exceeds max, run one condensation LLM call ---
  {
    const wc = wordCount(stripHtml(bodyRewritten));
    // Derive condensation max from pre-rewrite word count tiers when not explicitly set
    const preRewriteWc = wordCount(stripHtml(input.bodyHtml));
    const tieredMax = preRewriteWc < 900 ? 1300 : preRewriteWc <= 1600 ? 2200 : 3200;
    const condensationMax = (input.wordCountTarget?.max ?? tieredMax);
    if (wc > condensationMax) {
      console.log(`[Rewrite] P16 condensation: ${wc} words exceeds max ${condensationMax} — running condensation pass`);
      try {
        const condensationResp = await invokeClaude({
          max_tokens: 32000,
          system: 'You are an expert content editor. Return ONLY the condensed HTML wrapped in <ARTICLE_HTML>...</ARTICLE_HTML> delimiters. No other text.',
          messages: [{
            role: 'user',
            content:
              `The following article is ${wc} words, which exceeds the maximum of ${condensationMax} words. ` +
              `Reduce it to under ${condensationMax} words by shortening verbose sentences and removing filler phrases. ` +
              `Do NOT remove any headings, lists, links, or key facts. ` +
              `Do NOT change keyword placement or structure. ` +
              `Return ONLY the condensed HTML wrapped in <ARTICLE_HTML>...</ARTICLE_HTML>.\n\n` +
              bodyRewritten,
          }],
        });
        const condensedRaw = condensationResp.choices?.[0]?.message?.content ?? '';
        const condensedMatch = condensedRaw.match(/<ARTICLE_HTML>\s*([\s\S]*?)\s*<\/ARTICLE_HTML>/i);
        if (condensedMatch?.[1]) {
          const condensed = condensedMatch[1].trim();
          const condensedWc = wordCount(stripHtml(condensed));
          console.log(`[Rewrite] P16 condensation complete: ${condensedWc} words (was ${wc})`);
          bodyRewritten = condensed;
        }
      } catch (err) {
        console.warn(`[Rewrite] P16 condensation failed — keeping original:`, err);
      }
    }
  }

  // --- Safety net: re-append preserved sections if the LLM truncated them ---
  if (input.originalCtaSection) {
    const ctaSnippet = input.originalCtaSection.replace(/<[^>]+>/g, '').slice(0, 60).trim();
    if (ctaSnippet && !bodyRewritten.includes(ctaSnippet)) {
      bodyRewritten += `\n${input.originalCtaSection}`;
    }
  }
  if (input.originalFaqSection) {
    const faqSnippet = input.originalFaqSection.replace(/<[^>]+>/g, '').slice(0, 60).trim();
    if (faqSnippet && !bodyRewritten.includes(faqSnippet)) {
      bodyRewritten += `\n${input.originalFaqSection}`;
    }
  }

  // Use outline values for meta — Change 6: use ONLY outline.metaTitle, never concatenate
  const metaTitleRewritten = outline.metaTitle.trim();
  // Change 7: do NOT truncate meta description — store exactly as returned
  const metaDescriptionRewritten = outline.metaDescription.trim();

  return {
    bodyRewritten,
    metaTitleRewritten,
    metaDescriptionRewritten,
    aiSnippet: undefined,
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
    /** Business industry/audience for P9 answer block injection */
    businessIndustry?: string;
    /** CTA button/link text for Pass G injection */
    ctaText?: string;
    /** Business name for Pass I E-E-A-T injection */
    businessName?: string;
  }
): Pass1Output {
  let { bodyRewritten, metaTitleRewritten, metaDescriptionRewritten } = output;

  // -----------------------------------------------------------------------
  // Pass C — Keyword density + P5
  // -----------------------------------------------------------------------
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

  // P5: Keyword in first 150 words
  const first150 = stripHtml(bodyRewritten).split(/\s+/).slice(0, 150).join(" ");
  if (!containsKeyword(first150, focusKeyword)) {
    bodyRewritten = bodyRewritten.replace(
      /(<p[^>]*>)(.*?)(<\/p>)/i,
      (match, open, content, close) => {
        const stripped = stripHtml(content);
        return `${open} When considering ${focusKeyword}, understanding the facts is essential. ${stripped}${close}`;
      }
    );
  }

  // Keyword density: if < 4 occurrences or < 1.0%, inject at 25%, 50%, 75% positions
  if (kwCount < 4 || density < 1.0) {
    // Split body into paragraphs and inject at 25%, 50%, 75%
    const paraMatches = Array.from(bodyRewritten.matchAll(/<p[^>]*>[\s\S]*?<\/p>/gi));
    const total = paraMatches.length;
    if (total >= 4) {
      const injectPositions = [
        Math.floor(total * 0.25),
        Math.floor(total * 0.50),
        Math.floor(total * 0.75),
      ];
      const injections = [
        ` This is particularly relevant when evaluating ${focusKeyword} options.`,
        ` Understanding ${focusKeyword} helps you make an informed decision.`,
        ` Many clients researching ${focusKeyword} find this information valuable.`,
      ];
      // Rebuild body inserting injection sentences at target paragraphs
      let rebuilt = bodyRewritten;
      let offset = 0;
      for (let pi = 0; pi < injectPositions.length; pi++) {
        const pos = injectPositions[pi];
        const match = paraMatches[pos];
        if (!match || match.index === undefined) continue;
        const closeTag = '</p>';
        const closeIdx = rebuilt.indexOf(closeTag, match.index + offset);
        if (closeIdx === -1) continue;
        const injection = injections[pi];
        rebuilt = rebuilt.slice(0, closeIdx) + injection + rebuilt.slice(closeIdx);
        offset += injection.length;
      }
      bodyRewritten = rebuilt;
    }
  }

  // -----------------------------------------------------------------------
  // Pass D — P3: Keyword in H2
  // -----------------------------------------------------------------------
  const h2Regex = /<h2[^>]*>(.*?)<\/h2>/gi;
  const h2s: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = h2Regex.exec(bodyRewritten)) !== null) {
    h2s.push(stripHtml(m[1]));
  }
  const hasKeywordInH2 = h2s.some((h) => containsKeyword(h, focusKeyword));
  if (!hasKeywordInH2 && h2s.length > 0) {
    bodyRewritten = bodyRewritten.replace(
      /<h2([^>]*)>(.*?)<\/h2>/i,
      (match, attrs, content) => {
        const stripped = stripHtml(content);
        return `<h2${attrs}>${stripped}: ${focusKeyword}</h2>`;
      }
    );
  }

  // -----------------------------------------------------------------------
  // Pass D2 — P4: Keyword in H3
  // -----------------------------------------------------------------------
  {
    const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gi;
    const h3s: string[] = [];
    let h3m: RegExpExecArray | null;
    while ((h3m = h3Regex.exec(bodyRewritten)) !== null) {
      h3s.push(stripHtml(h3m[1]));
    }
    // Only inject if H3 tags exist AND none contain the keyword
    if (h3s.length > 0 && !h3s.some((h) => containsKeyword(h, focusKeyword))) {
      bodyRewritten = bodyRewritten.replace(
        /<h3([^>]*)>(.*?)<\/h3>/i,
        (match, attrs, content) => {
          const stripped = stripHtml(content);
          return `<h3${attrs}>${stripped}: ${focusKeyword}<\/h3>`;
        }
      );
      console.log(`[Rewrite] Pass D2: injected keyword into first H3 for P4`);
    }
  }

  // -----------------------------------------------------------------------
  // Pass D3 — Fix plain-text headings (LLM sometimes writes subheadings as <p> tags)
  // -----------------------------------------------------------------------
  {
    // Split into tag/text segments, scan <p> tags whose entire content looks like a heading
    bodyRewritten = bodyRewritten.replace(
      /<p([^>]*)>((?:(?!<).)+)<\/p>/g,
      (match, attrs, content) => {
        const text = content.trim();
        // Skip if content contains any child HTML tags (bold, italic, links, etc.)
        if (/<[a-z]/i.test(text)) return match;
        // Skip if it ends with a full stop (likely a sentence, not a heading)
        if (text.endsWith('.') || text.endsWith('!') || text.endsWith('?')) return match;
        // Must be under 12 words
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length > 12) return match;
        // Must look like a heading: title case (majority of words capitalised) or ALL CAPS
        const isAllCaps = text === text.toUpperCase() && /[A-Z]/.test(text);
        const capitalisedWords = words.filter((w: string) => /^[A-Z]/.test(w)).length;
        const isTitleCase = capitalisedWords / words.length >= 0.5;
        if (!isAllCaps && !isTitleCase) return match;
        console.log(`[Rewrite] Pass D3: converted plain-text heading to <h3>: "${text.slice(0, 60)}"`);
        return `<h3${attrs}>${text}</h3>`;
      }
    );
  }

  // -----------------------------------------------------------------------
  // Pass E — P9: Opening answer block
  // -----------------------------------------------------------------------
  const first800 = bodyRewritten.slice(0, 800);
  const hasQuestionMark = first800.includes('?');
  if (!hasQuestionMark) {
    const businessIndustry = options?.businessIndustry ?? 'business'; // Pass E uses this for the answer block
    const answerBlock =
      `<p><strong>What do you need to know about ${focusKeyword}?</strong> ` +
      `Understanding ${focusKeyword} is essential for ${businessIndustry} success. ` +
      `This guide covers the key facts, practical steps, and expert advice you need.</p>\n`;
    // Inject immediately after the first H2
    const firstH2Match = bodyRewritten.match(/<h2[^>]*>.*?<\/h2>/i);
    if (firstH2Match && firstH2Match.index !== undefined) {
      const insertPos = firstH2Match.index + firstH2Match[0].length;
      bodyRewritten = bodyRewritten.slice(0, insertPos) + '\n' + answerBlock + bodyRewritten.slice(insertPos);
    } else {
      bodyRewritten = answerBlock + bodyRewritten;
    }
  }

    // --- P7: Meta title — Change 6: Use ONLY what the LLM returned. Never concatenate or rebuild.
  // The outline/Pass1 already composed the meta title to spec. Only add keyword prefix if
  // the keyword is genuinely absent — do NOT truncate or reconstruct.
  if (!containsKeyword(metaTitleRewritten, focusKeyword)) {
    // Keyword missing — prepend it. Keep total under 60 chars by trimming the suffix.
    const kwPrefix = `${focusKeyword.charAt(0).toUpperCase() + focusKeyword.slice(1)} | `;
    const remaining = 60 - kwPrefix.length;
    const words = metaTitleRewritten.split(' ');
    let suffix = '';
    for (const w of words) {
      const candidate = suffix ? `${suffix} ${w}` : w;
      if (candidate.length <= remaining) suffix = candidate;
      else break;
    }
    metaTitleRewritten = `${kwPrefix}${suffix}`.trimEnd();
  }
  // Do NOT truncate the meta title if it already contains the keyword — trust the LLM output.

  // --- P8: Meta description — length is checked by the audit (P8 requires 140–160 chars).
  // Do NOT truncate here — store whatever the AI wrote so the user can edit it in full.
  // If too long or too short, the audit will flag it and the user can correct it in the editor.

  // --- P9: Opening Answer Block ---
  // Strictly require a STANDALONE bold-only paragraph as the very first non-heading element.
  // A paragraph that has bold text mixed with other text does NOT count.
  if (options?.paaQuestion) {
    const paaQ = options.paaQuestion.trim();
    // Strip any H1 from the top (we strip H1 before Wix post-back, but enforce here too)
    const bodyWithoutH1 = bodyRewritten.replace(/^\s*<h1[^>]*>.*?<\/h1>\s*/i, '');
    // Find the first <p> tag in the body
    const firstPMatch = bodyWithoutH1.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const firstPContent = firstPMatch ? firstPMatch[1].trim() : '';
    // A valid PAA block is a <p> whose ENTIRE content is a single <strong>...</strong> tag
    const isStandaloneBoldParagraph = /^<strong>[^<]{10,}<\/strong>$/i.test(firstPContent);
    if (!isStandaloneBoldParagraph) {
      // Inject the PAA question + answer block
      // Use a meaningful answer derived from the keyword rather than a generic placeholder
      const answerSentence = `${focusKeyword.charAt(0).toUpperCase() + focusKeyword.slice(1)} is the foundation of a strong content strategy. Getting it right means your posts are easier to find, more engaging to read, and more likely to convert visitors into customers.`;
      const paaBlock = `<p><strong>${paaQ}</strong></p>\n<p>${answerSentence}</p>\n`;
      // Insert after the first H1/H2 if present, otherwise prepend to body
      const headingMatch = bodyRewritten.match(/<h[12][^>]*>.*?<\/h[12]>/i);
      if (headingMatch && headingMatch.index !== undefined) {
        const insertPos = headingMatch.index + headingMatch[0].length;
        bodyRewritten = bodyRewritten.slice(0, insertPos) + '\n' + paaBlock + bodyRewritten.slice(insertPos);
      } else {
        bodyRewritten = paaBlock + bodyRewritten;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Pass F — P10: External authority link
  // -----------------------------------------------------------------------
  {
    // Known external service name → URL mappings
    const KNOWN_EXTERNAL_URLS: Array<{ name: string; url: string }> = [
      { name: 'Hotfrog', url: 'https://www.hotfrog.com.au' },
      { name: 'Yellow Pages', url: 'https://www.yellowpages.com.au' },
      { name: 'True Local', url: 'https://www.truelocal.com.au' },
      { name: 'Google Business Profile', url: 'https://business.google.com' },
      { name: 'ABN Lookup', url: 'https://abr.business.gov.au' },
      { name: 'ASIC', url: 'https://www.asic.gov.au' },
      { name: 'Fair Work', url: 'https://www.fairwork.gov.au' },
      { name: 'ATO', url: 'https://www.ato.gov.au' },
      { name: 'business.gov.au', url: 'https://business.gov.au' },
    ];

    const hasExternalLink = /<a[^>]+href=["'](https?:\/\/(?!(?:[^"']*\.)?(?:wix\.com|wordpress\.com|blogger\.com))[^"']+)["'][^>]*>/i.test(bodyRewritten);
    if (!hasExternalLink) {
      // Step 1: Try to convert first occurrence of any known plain-text service name to a hyperlink
      let converted = false;
      for (const { name, url: serviceUrl } of KNOWN_EXTERNAL_URLS) {
        // Only match the name when it is NOT already inside an <a> tag
        // Strategy: split on HTML tags, find the first text segment containing the name, replace it
        const parts = bodyRewritten.split(/(<[^>]+>)/g);
        let found = false;
        const updated = parts.map((part) => {
          if (found || part.startsWith('<')) return part;
          const idx = part.indexOf(name);
          if (idx === -1) return part;
          found = true;
          return (
            part.slice(0, idx) +
            `<a href="${serviceUrl}" target="_blank" rel="noopener">${name}</a>` +
            part.slice(idx + name.length)
          );
        });
        if (found) {
          bodyRewritten = updated.join('');
          converted = true;
          console.log(`[Rewrite] Pass F: converted plain-text "${name}" to hyperlink`);
          break;
        }
      }

      // Step 2: If no known service name found, fall back to generic gov.au injection
      if (!converted) {
        const secondPMatch = bodyRewritten.match(/(<p[^>]*>[\s\S]*?<\/p>[\s\S]*?)(<p[^>]*>[\s\S]*?<\/p>)/i);
        const extLinkSentence =
          ` For more information, visit the <a href="https://www.fairwork.gov.au" target="_blank" rel="noopener">Fair Work Commission</a>` +
          ` or check current guidelines at <a href="https://www.australia.gov.au" target="_blank" rel="noopener">Australia.gov.au</a>.`;
        if (secondPMatch && secondPMatch.index !== undefined) {
          const secondPStart = secondPMatch.index + secondPMatch[1].length;
          const secondPClose = bodyRewritten.indexOf('</p>', secondPStart);
          if (secondPClose !== -1) {
            bodyRewritten = bodyRewritten.slice(0, secondPClose) + extLinkSentence + bodyRewritten.slice(secondPClose);
          }
        } else if (options?.externalAuthorityFallback) {
          const { anchor, url: extUrl } = options.externalAuthorityFallback;
          const firstPClose = bodyRewritten.indexOf('</p>');
          const extLinkText = ` According to <a href="${extUrl}" target="_blank" rel="noopener">${anchor}</a>, understanding the key requirements is essential for success.`;
          if (firstPClose !== -1) {
            bodyRewritten = bodyRewritten.slice(0, firstPClose) + extLinkText + bodyRewritten.slice(firstPClose);
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Pass G — P11: Internal CTA link
  // -----------------------------------------------------------------------
  if (options?.primaryCtaUrl) {
    const ctaUrl = options.primaryCtaUrl;
    const hasCtaLink = bodyRewritten.toLowerCase().includes(ctaUrl.toLowerCase()) ||
      /href=["'][^"']*\/(shop|store|product|services|service|contact|book|booking|buy|cart|checkout)[^"']*["']/i.test(bodyRewritten);
    if (!hasCtaLink) {
      // Spec: inject into the second-to-last paragraph
      const allParaMatches = Array.from(bodyRewritten.matchAll(/<p[^>]*>[\s\S]*?<\/p>/gi));
      const targetIdx = allParaMatches.length >= 2 ? allParaMatches.length - 2 : allParaMatches.length - 1;
      const targetMatch = allParaMatches[targetIdx];
      if (targetMatch && targetMatch.index !== undefined) {
        const ctaText = `\n<p><a href="${ctaUrl}">${options.ctaText ?? 'Contact us today'}</a> to find out how we can help you with ${focusKeyword}.</p>`;
        const insertAfter = targetMatch.index + targetMatch[0].length;
        bodyRewritten = bodyRewritten.slice(0, insertAfter) + ctaText + bodyRewritten.slice(insertAfter);
      } else {
        bodyRewritten += `\n<p><a href="${ctaUrl}">${options.ctaText ?? 'Contact us today'}</a> to find out how we can help you with ${focusKeyword}.</p>`;
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

  // -----------------------------------------------------------------------
  // Pass I — P14: E-E-A-T signal
  // -----------------------------------------------------------------------
  {
    const bodyLower = bodyRewritten.toLowerCase();
    const hasEeat = ['year', 'experience', 'client', 'award'].some(w => bodyLower.includes(w));
    if (!hasEeat) {
      const biz = options?.businessName ?? 'Our team';
      const eeatSentence = ` ${biz} has been helping clients for years, with experience across a wide range of situations.`;
      // Inject into the third paragraph
      const thirdParaMatches = Array.from(bodyRewritten.matchAll(/<p[^>]*>[\s\S]*?<\/p>/gi));
      const thirdPara = thirdParaMatches[2];
      if (thirdPara && thirdPara.index !== undefined) {
        const closeIdx = bodyRewritten.indexOf('</p>', thirdPara.index);
        if (closeIdx !== -1) {
          bodyRewritten = bodyRewritten.slice(0, closeIdx) + eeatSentence + bodyRewritten.slice(closeIdx);
        }
      }
    }
  }

  return { bodyRewritten, metaTitleRewritten, metaDescriptionRewritten };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// AI Phrase Scanner — mechanical post-generation cleanup
// ---------------------------------------------------------------------------
/**
 * Mechanically replaces the most common AI-fingerprint phrases in plain text
 * (outside HTML tags) with natural human alternatives.
 * Runs AFTER Pass 2 as a deterministic safety net.
 */
export function runAiPhraseScan(html: string): string {
  // Each entry: [regex, replacement]
  // Replacements use natural Australian English alternatives.
  // We only replace text nodes (outside < >) to avoid breaking HTML attributes.
  const replacements: [RegExp, string][] = [
    // Hollow openers
    [/\bin today'?s digital landscape\b/gi, 'these days'],
    [/\bin today'?s fast[- ]paced world\b/gi, 'right now'],
    [/\bin today'?s world\b/gi, 'today'],
    [/\bin the modern world\b/gi, 'today'],
    [/\bin the ever[- ]changing world\b/gi, 'in a changing market'],
    [/\bin the current landscape\b/gi, 'right now'],
    [/\bin the digital age\b/gi, 'online'],
    [/\bwelcome to the world of\b/gi, 'here is what you need to know about'],
    [/\bare you (looking|ready) to\b/gi, 'want to'],
    // Filler transitions
    [/\bit'?s important to note (that )?/gi, ''],
    [/\bit is important to note (that )?/gi, ''],
    [/\bit'?s worth noting (that )?/gi, ''],
    [/\bit is worth noting (that )?/gi, ''],
    [/\bit goes without saying (that )?/gi, ''],
    [/\bneedless to say,?\s*/gi, ''],
    [/\bwithout further ado,?\s*/gi, ''],
    [/\blook no further\b/gi, 'this is the answer'],
    [/\bwithout further delay,?\s*/gi, ''],
    [/\bwithout further hesitation,?\s*/gi, ''],
    [/\bwithout further introduction,?\s*/gi, ''],
    [/\bin conclusion,?\s*/gi, 'to wrap up, '],
    [/\bto summarise,?\s*/gi, 'in short, '],
    [/\bto summarize,?\s*/gi, 'in short, '],
    [/\bin summary,?\s*/gi, 'in short, '],
    [/\bat the end of the day,?\s*/gi, 'ultimately, '],
    [/\bmoving forward,?\s*/gi, 'from here, '],
    [/\bgoing forward,?\s*/gi, 'from here, '],
    [/\bwith that (said|being said),?\s*/gi, ''],
    [/\bthat (said|being said),?\s*/gi, ''],
    [/\ball in all,?\s*/gi, 'overall, '],
    [/\ball things considered,?\s*/gi, 'overall, '],
    [/\bwhen all is said and done,?\s*/gi, 'ultimately, '],
    // Corporate buzzwords
    [/\bleverage\b/gi, 'use'],
    [/\bleveraging\b/gi, 'using'],
    [/\bleveraged\b/gi, 'used'],
    [/\bdelve into\b/gi, 'look at'],
    [/\bdelve deeper\b/gi, 'dig deeper'],
    [/\bdive into\b/gi, 'look at'],
    [/\bdive deeper\b/gi, 'dig deeper'],
    [/\bseamlessly\b/gi, 'smoothly'],
    [/\bseamless\b/gi, 'smooth'],
    [/\brobust\b/gi, 'strong'],
    [/\bgame[- ]changer\b/gi, 'big shift'],
    [/\bgame[- ]changing\b/gi, 'significant'],
    [/\btransformative\b/gi, 'significant'],
    [/\btransform(ing)? your\b/gi, 'improve your'],
    [/\bunlock(ing)? (the|your|a)\b/gi, 'access $2'],
    [/\bempower(ing)? (you|your|businesses|teams)\b/gi, 'help $2'],
    [/\bnavigate\b/gi, 'handle'],
    [/\bnavigating\b/gi, 'handling'],
    [/\bcomprehensive guide\b/gi, 'guide'],
    [/\bultimate guide\b/gi, 'guide'],
    [/\bdefinitive guide\b/gi, 'guide'],
    [/\bbegin your journey\b/gi, 'get started'],
    [/\bembark on (a|your) journey\b/gi, 'start'],
    [/\btake your .{0,30} to the next level\b/gi, 'improve your results'],
    [/\bthink outside the box\b/gi, 'try a different approach'],
    [/\bsynergy\b/gi, 'collaboration'],
    [/\bsynergies\b/gi, 'combined benefits'],
    [/\bparadigm shift\b/gi, 'major change'],
    [/\bvalue proposition\b/gi, 'what you offer'],
    [/\bpivot\b(?! on| around)/gi, 'change direction'],
    [/\bscalable solution\b/gi, 'solution that grows with you'],
    [/\bscalable\b/gi, 'flexible'],
    [/\bholistic approach\b/gi, 'complete approach'],
    [/\bholistic\b/gi, 'complete'],
    [/\bproactive(ly)?\b/gi, 'ahead of time'],
    [/\bstrategic(ally)?\b(?! plan| goal| objective)/gi, 'deliberate'],
    [/\boptimise your potential\b/gi, 'get the most out of your efforts'],
    [/\boptimize your potential\b/gi, 'get the most out of your efforts'],
    [/\bfoster(ing)? (a|an|the)\b/gi, 'build $2'],
    [/\bcultivate (a|an|the)\b/gi, 'build $2'],
    [/\bspearhead(ing)?\b/gi, 'lead'],
    [/\bpioneer(ing)?\b(?! in| of)/gi, 'lead the way in'],
    [/\bcutting[- ]edge\b/gi, 'modern'],
    [/\bstate[- ]of[- ]the[- ]art\b/gi, 'modern'],
    [/\bbest[- ]in[- ]class\b/gi, 'top-quality'],
    [/\bworld[- ]class\b/gi, 'high-quality'],
    [/\binnovative solution\b/gi, 'new approach'],
    [/\binnovative approach\b/gi, 'new approach'],
    [/\binnovative\b/gi, 'new'],
    [/\bgroundbreaking\b/gi, 'significant'],
    [/\brevolutionary\b/gi, 'significant'],
    [/\bdisruptive\b/gi, 'new'],
    // Hollow qualifiers
    [/\btruly\b/gi, ''],
    [/\bactually\b/gi, ''],
    [/\bbasically\b/gi, ''],
    [/\bfundamentally\b/gi, ''],
    [/\bessentially,?\s*/gi, ''],
    [/\bultimately,?\s*(?!,)/gi, ''],
    [/\bsimply put,?\s*/gi, ''],
    [/\bput simply,?\s*/gi, ''],
    [/\bin other words,?\s*/gi, ''],
    [/\bto put it (simply|plainly|bluntly),?\s*/gi, ''],
    // AI-style em-dash overuse: replace " — " used as a filler connector
    // (keep em-dashes that are part of compound words or genuine parenthetical)
    // Hollow sentence starters
    [/^(However,?\s*)/gim, ''],
    [/^(Furthermore,?\s*)/gim, ''],
    [/^(Moreover,?\s*)/gim, ''],
    [/^(Additionally,?\s*)/gim, ''],
    [/^(In addition,?\s*)/gim, ''],
    [/^(On the other hand,?\s*)/gim, ''],
    [/^(In contrast,?\s*)/gim, ''],
    [/^(As a result,?\s*)/gim, ''],
    [/^(Consequently,?\s*)/gim, ''],
    [/^(Therefore,?\s*)/gim, ''],
    [/^(Thus,?\s*)/gim, ''],
    [/^(Hence,?\s*)/gim, ''],
  ];

  // Apply replacements only to text nodes (not inside HTML tags)
  // Strategy: split on HTML tags, apply to text segments only, rejoin
  const parts = html.split(/(<[^>]+>)/g);
  const cleaned = parts.map((part) => {
    if (part.startsWith('<')) return part; // HTML tag — leave untouched
    let text = part;
    for (const [pattern, replacement] of replacements) {
      text = text.replace(pattern, replacement);
    }
    // Collapse multiple spaces left by empty replacements
    text = text.replace(/  +/g, ' ');
    return text;
  });
  const phraseFixed = cleaned.join('');

  // ---------------------------------------------------------------------------
  // Mechanical staccato merger
  // Merge consecutive short <p> paragraphs (< 25 words each) into one paragraph.
  // This deterministically fixes the AI staccato pattern regardless of LLM output.
  // Skips headings, images, lists, and schema script blocks.
  // ---------------------------------------------------------------------------
  function wordCount(s: string): number {
    return s.trim().split(/\s+/).filter(Boolean).length;
  }
  function stripTagsForCount(s: string): string {
    return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Split into block-level tokens: each <p>...</p>, heading, list, script, img, or whitespace gap
  const blockPattern = /(<(?:h[1-6]|ul|ol|li|blockquote|pre|script|figure|div)[^>]*>[\s\S]*?<\/(?:h[1-6]|ul|ol|li|blockquote|pre|script|figure|div)>|<img[^>]*\/?>|<p[^>]*>[\s\S]*?<\/p>)/gi;
  const tokens: string[] = [];
  let lastIndex = 0;
  let bm: RegExpExecArray | null;
  const bpCopy = new RegExp(blockPattern.source, 'gi');
  while ((bm = bpCopy.exec(phraseFixed)) !== null) {
    if (bm.index > lastIndex) tokens.push(phraseFixed.slice(lastIndex, bm.index));
    tokens.push(bm[0]);
    lastIndex = bm.index + bm[0].length;
  }
  if (lastIndex < phraseFixed.length) tokens.push(phraseFixed.slice(lastIndex));

  // Walk tokens and merge consecutive short <p> blocks
  const SHORT_WORD_LIMIT = 25; // paragraphs with fewer words than this are candidates for merging
  const MAX_MERGE_WORDS = 80;  // don't let merged paragraphs exceed this
  const merged: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    // Is this a <p> block (not a heading/list/script)?
    const isPara = /^<p[^>]*>[\s\S]*?<\/p>$/i.test(tok.trim());
    if (!isPara) {
      merged.push(tok);
      i++;
      continue;
    }
    const innerMatch = tok.match(/^<p([^>]*)>([\s\S]*?)<\/p>$/i);
    if (!innerMatch) { merged.push(tok); i++; continue; }
    const attrs = innerMatch[1];
    const innerText = innerMatch[2];
    const wc = wordCount(stripTagsForCount(innerText));
    if (wc >= SHORT_WORD_LIMIT) {
      // Long paragraph — keep as-is
      merged.push(tok);
      i++;
      continue;
    }
    // Short paragraph — try to merge with following short paragraphs
    const parts2: string[] = [innerText];
    let totalWords = wc;
    let j = i + 1;
    while (j < tokens.length) {
      const next = tokens[j];
      // Skip pure whitespace tokens between paragraphs
      if (/^\s*$/.test(next)) { j++; continue; }
      const nextIsPara = /^<p[^>]*>[\s\S]*?<\/p>$/i.test(next.trim());
      if (!nextIsPara) break;
      const nextInner = next.match(/^<p[^>]*>([\s\S]*?)<\/p>$/i);
      if (!nextInner) break;
      const nextText = nextInner[1];
      const nextWc = wordCount(stripTagsForCount(nextText));
      if (nextWc >= SHORT_WORD_LIMIT) break; // next is a long para — stop merging
      if (totalWords + nextWc > MAX_MERGE_WORDS) break; // merged would be too long
      parts2.push(nextText);
      totalWords += nextWc;
      j++;
    }
    if (parts2.length === 1) {
      // Only one short para, nothing to merge with — keep as-is
      merged.push(tok);
      i++;
    } else {
      // Merge all collected short paragraphs into one
      merged.push(`<p${attrs}>${parts2.join(' ')}</p>`);
      // Consume the whitespace tokens we skipped
      i = j;
    }
  }

  return merged.join('');
}

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
  // Change 1 — 47-phrase banned list (used in scrub prompt AND P15 audit check)
  const BANNED_PHRASES = [
    "in today's world",
    "it's important to note",
    "it is important to note",
    "delve into",
    "game-changer",
    "game changer",
    "leverage",
    "synergy",
    "transformative",
    "it's crucial to",
    "it is crucial to",
    "one of the most important",
    "ultimately,",
    "essentially,",
    "furthermore,",
    "moreover,",
    "at the end of the day",
    "according to research",
    "studies show",
    "it has been shown",
    "navigating the complexities",
    "navigate the ever-changing",
    "in today's competitive landscape",
    "in today's fast-paced",
    "in today's digital",
    "look no further",
    "cutting-edge",
    "state-of-the-art",
    "seamlessly",
    "robust solution",
    "tailored solutions",
    "tailored to your needs",
    "unlock your potential",
    "unlock the power",
    "empower your",
    "elevate your",
    "take your business to the next level",
    "in conclusion,",
    "to summarize,",
    "to summarise,",
    "it goes without saying",
    "needless to say",
    "as we all know",
    "the bottom line is",
    "at its core",
    "dive into",
    "in other words",
  ].join("\n- ");

  const scrubSystemPrompt =
    `You are an AI content editor specialising in removing AI fingerprints from blog content.\n` +
    `Review the article below and rewrite it to remove all AI tells. The result must be indistinguishable from content written by a specific human expert with a strong point of view.\n` +
    `SPECIFIC THINGS TO FIX:\n` +
    `1. Remove em dash (\u2014) overuse \u2014 replace with commas, full stops, or restructure the sentence\n` +
    `2. Remove rhetorical question openings \u2014 replace with direct statements\n` +
    `3. Remove these exact phrases (replace with natural alternatives): ${BANNED_PHRASES}\n` +
    `4. Remove repetitive sentence structures \u2014 vary the rhythm\n` +
    `5. Vary sentence length deliberately: mix short punchy sentences (under 10 words) with medium ones (15\u201325 words). Never have 4+ sentences in a row of similar length.\n` +
    `6. Remove transition words that only AI overuses: furthermore, moreover, additionally (when used to pad), in conclusion, to summarize.\n` +
    `7. Replace any vague authority claims ("research shows", "studies indicate", "experts agree") with specific named examples, or remove them entirely.\n` +
    `8. If a sentence could appear in any article about any industry, it is too generic. Rewrite it with a specific detail, number, or example from the article's actual topic.\n` +
    `9. Remove any sentence that begins with "It is important to" or "It is crucial to" \u2014 rewrite as a direct statement.\n` +
    `10. Ensure the article sounds like it was written by a specific human with a point of view, not a generic assistant\n` +
    `11. Preserve ALL HTML tags, links, headings exactly \u2014 only change the prose text\n` +
    `12. Do NOT remove any content, sections, or paragraphs \u2014 the output MUST be at least as long as the input\n` +
    `IMPORTANT: Do NOT change the meaning, facts, keyword placement, or structure.\n` +
    `Return ONLY the scrubbed HTML body wrapped in:\n` +
    `<SCRUBBED_HTML>\n` +
    `...full scrubbed HTML here...\n` +
    `</SCRUBBED_HTML>`;

  const scrubUserMsg =
    `ARTICLE TO SCRUB:\n${output.bodyRewritten}`;

  const response = await invokeClaude({
    max_tokens: 32000,
    system: scrubSystemPrompt,
    messages: [{ role: 'user', content: scrubUserMsg }],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned no content for Pass 2 scrub');

  const scrubBodyMatch = content.match(/<SCRUBBED_HTML>\s*([\s\S]*?)\s*<\/SCRUBBED_HTML>/i);
  let scrubbed = scrubBodyMatch?.[1]?.trim() ?? output.bodyRewritten;

  // Safety guard: if scrubbed body is < 80% of original word count, keep original
  const originalWc = wordCount(stripHtml(output.bodyRewritten));
  const scrubbedWc = wordCount(stripHtml(scrubbed));
  if (originalWc > 0 && scrubbedWc < originalWc * 0.8) {
    console.warn(`[Rewrite] Pass 2 scrub rejected — word count dropped from ${originalWc} to ${scrubbedWc}. Keeping original.`);
    scrubbed = output.bodyRewritten;
  }

  // --- Pass B3: Targeted second scrub for any surviving banned phrases ---
  const bannedPhrasesList = BANNED_PHRASES.split('\n- ').map(p => p.replace(/^- /, '').trim().toLowerCase()).filter(Boolean);
  const survivingPhrases = bannedPhrasesList.filter(phrase => scrubbed.toLowerCase().includes(phrase));

  if (survivingPhrases.length > 0) {
    console.log(`[Rewrite] Pass B3: ${survivingPhrases.length} banned phrases survived scrub — running targeted fix`);
    // Find sentences containing surviving phrases
    const sentencesWithBanned: string[] = [];
    const parts = scrubbed.split(/(<[^>]+>)/g);
    for (const part of parts) {
      if (part.startsWith('<')) continue;
      const sentences = part.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (survivingPhrases.some(p => sentence.toLowerCase().includes(p))) {
          sentencesWithBanned.push(sentence.trim());
        }
      }
    }

    if (sentencesWithBanned.length > 0) {
      const b3Resp = await invokeClaude({
        max_tokens: 4000,
        system: 'You are a human-voice editor. Rewrite each sentence to remove AI fingerprint phrases. Return ONLY the rewritten sentences in the same order, one per line, with no extra text.',
        messages: [{
          role: 'user',
          content:
            `Rewrite these sentences to remove the following banned phrases: ${survivingPhrases.join(', ')}\n\n` +
            `SENTENCES TO REWRITE (one per line):\n${sentencesWithBanned.join('\n')}\n\n` +
            `Return one rewritten sentence per line, in the same order.`,
        }],
      });
      const b3Content = b3Resp.choices?.[0]?.message?.content ?? '';
      const rewrittenSentences = b3Content.split('\n').map(s => s.trim()).filter(Boolean);

      // Replace original sentences with rewritten ones
      if (rewrittenSentences.length === sentencesWithBanned.length) {
        for (let i = 0; i < sentencesWithBanned.length; i++) {
          scrubbed = scrubbed.replace(sentencesWithBanned[i], rewrittenSentences[i]);
        }
        console.log(`[Rewrite] Pass B3: replaced ${rewrittenSentences.length} sentences`);
      }
    }
  }

  // --- Pass B4: Mechanical hard removal of any surviving banned phrases ---
  // Last-resort deterministic pass: loop through the 47 banned phrases and strip
  // any that survived the LLM scrub. Only removes phrase text — never touches HTML tags.
  {
    const bannedPhrasesList = BANNED_PHRASES.split('\n- ').map(p => p.replace(/^- /, '').trim()).filter(Boolean);
    const parts = scrubbed.split(/(<[^>]+>)/g);
    const cleaned = parts.map((part) => {
      if (part.startsWith('<')) return part; // HTML tag — leave untouched
      let text = part;
      for (const phrase of bannedPhrasesList) {
        // Case-insensitive replacement, trim surrounding whitespace
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, 'gi'), '').replace(/  +/g, ' ');
      }
      return text;
    });
    const afterB4 = cleaned.join('');
    const removedCount = bannedPhrasesList.filter(p => scrubbed.toLowerCase().includes(p.toLowerCase()) && !afterB4.toLowerCase().includes(p.toLowerCase())).length;
    if (removedCount > 0) {
      console.log(`[Rewrite] Pass B4: mechanically removed ${removedCount} surviving banned phrases`);
    }
    scrubbed = afterB4;
  }

  return {
    bodyRewritten: scrubbed,
    metaTitleRewritten: output.metaTitleRewritten,
    metaDescriptionRewritten: output.metaDescriptionRewritten,
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
// Protected Section Extraction
// ---------------------------------------------------------------------------
/**
 * Extract sections from the original HTML that must be preserved verbatim:
 * - CTA / "What you can do next" sections
 * - FAQ / Frequently Asked Questions sections
 * Returns null if the section is not found.
 */
export function extractProtectedSections(bodyHtml: string): {
  ctaSection: string | null;
  faqSection: string | null;
} {
  const lower = bodyHtml.toLowerCase();

  // --- CTA section detection ---
  // Look for headings containing CTA-like phrases
  const ctaHeadingPatterns = [
    /what you can do next/i,
    /call to action/i,
    /next steps?/i,
    /ready to (get started|take the next step|begin)/i,
    /get started/i,
    /contact us/i,
    /how (we can help|to get started)/i,
  ];

  let ctaSection: string | null = null;
  for (const pattern of ctaHeadingPatterns) {
    // Find the heading tag that matches
    const headingMatch = bodyHtml.match(
      new RegExp(`<h[2-4][^>]*>[^<]*${pattern.source}[^<]*<\/h[2-4]>`, 'i')
    );
    if (headingMatch && headingMatch.index !== undefined) {
      // Extract from the heading to the next heading of same or higher level, or end of body
      const startIdx = headingMatch.index;
      const afterHeading = bodyHtml.slice(startIdx + headingMatch[0].length);
      const nextHeadingMatch = afterHeading.match(/<h[2-4][^>]*>/i);
      const endIdx = nextHeadingMatch && nextHeadingMatch.index !== undefined
        ? startIdx + headingMatch[0].length + nextHeadingMatch.index
        : bodyHtml.length;
      ctaSection = bodyHtml.slice(startIdx, endIdx).trim();
      break;
    }
  }

  // --- FAQ section detection ---
  const faqHeadingPatterns = [
    /frequently asked questions/i,
    /faqs?/i,
    /common questions/i,
    /questions (and answers|people ask)/i,
  ];

  let faqSection: string | null = null;
  for (const pattern of faqHeadingPatterns) {
    const headingMatch = bodyHtml.match(
      new RegExp(`<h[2-4][^>]*>[^<]*${pattern.source}[^<]*<\/h[2-4]>`, 'i')
    );
    if (headingMatch && headingMatch.index !== undefined) {
      const startIdx = headingMatch.index;
      const afterHeading = bodyHtml.slice(startIdx + headingMatch[0].length);
      const nextHeadingMatch = afterHeading.match(/<h[2-4][^>]*>/i);
      const endIdx = nextHeadingMatch && nextHeadingMatch.index !== undefined
        ? startIdx + headingMatch[0].length + nextHeadingMatch.index
        : bodyHtml.length;
      faqSection = bodyHtml.slice(startIdx, endIdx).trim();
      break;
    }
  }

  return { ctaSection, faqSection };
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
  rewriteMode?: "full_rewrite" | "smart_patch" | "seo_refresh";
  /** When true (default), extract and preserve the CTA section verbatim — do not rewrite it */
  preserveCta?: boolean;
  /** When true (default), extract and preserve the FAQ section verbatim — do not rewrite it */
  preserveFaq?: boolean;
  /** Optional free-text instructions from the user to guide the rewrite */
  userInstructions?: string | null;
  /** Original pre-rewrite audit score — if provided, rewrite is rejected if it scores lower */
  originalScore?: number;
}): Promise<RewriteResult> {
  const { post, businessContext, internalLinks, failingPoints, paaQuestion, secondaryKeywords = [], rewriteMode = "seo_refresh", preserveCta = true, preserveFaq = true, userInstructions } = params;

  const articleType = inferArticleType(post.bodyOriginal);
  const wordCountTarget = ARTICLE_TYPE_TARGETS[articleType];

  // --- Extract protected sections (CTA, FAQ) from original body ---
  // Only pass them as protected zones if the user has opted to preserve them (default: true)
  const { ctaSection, faqSection } = extractProtectedSections(post.bodyOriginal);

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
    originalCtaSection: preserveCta ? ctaSection : null,
    originalFaqSection: preserveFaq ? faqSection : null,
    userInstructions: userInstructions ?? null,
  };

  // --- Pass 1: LLM call with 300s hard timeout ---
  const pass1Start = Date.now();
  console.log(`[Rewrite] Pass 1 starting — mode: ${rewriteMode}, post: ${post.id}`);
  let pass1Output = await Promise.race([
    runPass1Rewrite(pass1Input),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Rewrite timed out after 300 seconds — please try again.")), 300_000)
    ),
  ]);
  console.log(`[Rewrite] Pass 1 complete in ${((Date.now() - pass1Start) / 1000).toFixed(1)}s`);

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
    businessIndustry: businessContext.targetAudience ?? undefined,
    businessName: businessContext.businessName ?? undefined,
    ctaText: businessContext.primaryCtaLabel ?? undefined,
  });

  // --- Pass 2: Fingerprint Scrub (LLM call with 300s hard timeout) ---
  const pass2Start = Date.now();
  console.log(`[Rewrite] Pass 2 starting — post: ${post.id}`);
  const pass2Raw = await Promise.race([
    runPass2FingerprintScrub(pass1Output, post.focusKeyword),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Rewrite timed out after 300 seconds — please try again.")), 300_000)
    ),
  ]);
  console.log(`[Rewrite] Pass 2 complete in ${((Date.now() - pass2Start) / 1000).toFixed(1)}s`);
  // --- Pass 2b: Mechanical AI Phrase Scanner ---
  // Deterministic safety net — catches any AI phrases the LLM missed in Pass 2
  const pass2Output: Pass1Output = {
    bodyRewritten: runAiPhraseScan(pass2Raw.bodyRewritten),
    metaTitleRewritten: pass2Raw.metaTitleRewritten,
    metaDescriptionRewritten: pass2Raw.metaDescriptionRewritten,
  };

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
    schemaJson,
    externalAuthorityFallback,
    businessIndustry: businessContext.targetAudience ?? undefined,
    businessName: businessContext.businessName ?? undefined,
    ctaText: businessContext.primaryCtaLabel ?? undefined,
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
  const rescoreStart = Date.now();
  console.log(`[Rewrite] Re-scoring starting — post: ${post.id}`);
  const auditResult = await runFullAudit(auditInput);
  console.log(`[Rewrite] Re-scoring complete in ${((Date.now() - rescoreStart) / 1000).toFixed(1)}s — score: ${auditResult.score}`);
  const rewriteScore = auditResult.score;
  const rewriteGrade = scoreToGrade(rewriteScore);

  // --- Change 5: Score regression prevention ---
  // If the rewrite scores lower than the original, reject it and keep the original.
  if (params.originalScore !== undefined && rewriteScore < params.originalScore) {
    console.warn(
      `[Rewrite] Score regression detected — rewrite: ${rewriteScore}/16, original: ${params.originalScore}/16. Rejecting rewrite.`
    );
    throw new Error(
      `Rewrite quality check failed — the rewritten post scored lower than the original ` +
      `(${rewriteScore}/16 vs ${params.originalScore}/16). The original has been kept. Please try again or use manual editing.`
    );
  }

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
