/**
 * bloginatorFixers.ts — Per-check repair engine for the 29-point / 100-standard audit.
 *
 * Exported entry point: applyFixers()
 *
 * Two modes (wired from the rewrite router):
 *   "adjust"  — fix only the failed checks, then re-audit, repeat ≤ 3× until score ≥ 90.
 *   "refresh" — full rewrite already happened; run one pass of deterministic fixers to clean up.
 *
 * Rules:
 *   - Deterministic fixers run first (no LLM, instant).
 *   - Content checks (MIC-03, MIC-05, EAT-02, EAT-03, EAT-04, EAT-07) get one small AI call.
 *   - Never fabricate stats, quotes, or authority links — leave those checks failing if real data unavailable.
 *   - MAC-01 (URL silo), MAC-12 (Core Web Vitals), MAC-13 (llms.txt) cannot be fixed in the article body.
 *     They are returned in surfaceToUser[] so the UI can show a message.
 */

import { invokeClaude } from "./_core/claude";
import { runFullAudit, PostAuditInput, AuditResult } from "./audit.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixerContext {
  /** Current article body HTML */
  bodyHtml: string;
  /** Focus keyword */
  focusKeyword: string;
  /** Post URL (for audit input) */
  url: string;
  /** Current meta title */
  metaTitle: string;
  /** Current meta description */
  metaDescription: string;
  /** Hub keyword this post should link up to (for MAC-09) */
  hubKeyword?: string | null;
  /** True if this is a hub/pillar page (for MAC-10) */
  isHub?: boolean;
  /** Available internal sibling URLs+titles (for MAC-09, MAC-11) */
  internalLinks?: Array<{ url: string; title: string }>;
  /** Business name (for schema) */
  businessName?: string;
  /** Business website (for schema) */
  websiteUrl?: string;
  /** Author name (for schema) */
  authorName?: string;
  /** schemaJson already stored on this post */
  schemaJson?: object | null;
  /** Live check values (passed in; fixers can't change these) */
  liveChecks?: { coreWebVitalsPass?: boolean; llmsTxtPresent?: boolean };
  /** Primary CTA URL for MAC-11 internal linking */
  primaryCtaUrl?: string | null;
}

export interface FixerOutput {
  bodyHtml: string;
  metaTitle: string;
  metaDescription: string;
  schemaJson?: object | null;
}

export interface FixerResult {
  output: FixerOutput;
  finalAuditResult: AuditResult;
  rounds: number;
  surfaceToUser: Array<{ id: string; parameter: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Checks that cannot be fixed in the article body — surface to user
// ---------------------------------------------------------------------------

const UNFIXABLE: Record<string, string> = {
  'MAC-01': 'URL structure cannot be changed after publishing. Ensure the slug uses subdirectories and no date segments.',
  'MAC-12': 'Core Web Vitals are measured by Google PageSpeed Insights — fix performance issues in your CMS/hosting settings.',
  'MAC-13': 'Add an /llms.txt file to your domain root to pass this AI-citation check.',
};

// ---------------------------------------------------------------------------
// AI buzzwords (EAT-08) — same list as the audit engine
// ---------------------------------------------------------------------------

const AI_BUZZWORDS = [
  'delve', 'tapestry', 'seamlessly', 'multifaceted', 'nuanced', 'game-changer',
  'game changer', 'transformative', 'leveraging', 'harnessing', 'cutting-edge',
  'streamline', 'unprecedented', 'paradigm', 'synergy', 'holistic', 'empower',
  'spearhead', 'meticulous', 'crucial', 'pivotal', 'intricate', 'embark',
  'realm', 'fostering', 'unleash', 'elevating', 'revolutionize', 'bespoke',
  'robust', 'leverage', 'utilize', 'utilise', 'in today\'s world',
  'in today\'s fast-paced', 'in today\'s digital', 'in today\'s competitive',
  'it\'s important to note', 'it is important to note', 'it\'s crucial to',
  'it is crucial to', 'furthermore,', 'moreover,', 'at the end of the day',
  'in conclusion,', 'to summarize,', 'to summarise,', 'dive into',
];

// ---------------------------------------------------------------------------
// Deterministic fixers
// ---------------------------------------------------------------------------

/** MAC-02: Truncate meta title to ≤ 60 chars at word boundary */
function fixMac02(ctx: FixerContext, out: FixerOutput): FixerOutput {
  if (out.metaTitle.length <= 60) return out;
  const trimmed = out.metaTitle.substring(0, 57).replace(/\s+\S*$/, '') + '…';
  return { ...out, metaTitle: trimmed };
}

/** MAC-03: Truncate meta description to ≤ 160 chars at word boundary */
function fixMac03(ctx: FixerContext, out: FixerOutput): FixerOutput {
  if (out.metaDescription.length <= 160) return out;
  const trimmed = out.metaDescription.substring(0, 157).replace(/\s+\S*$/, '') + '…';
  return { ...out, metaDescription: trimmed };
}

/** MAC-04: Inject keyword into title and/or description if missing */
function fixMac04(ctx: FixerContext, out: FixerOutput): FixerOutput {
  const kw = ctx.focusKeyword.toLowerCase();
  let { metaTitle, metaDescription } = out;

  if (!metaTitle.toLowerCase().includes(kw)) {
    // Prepend keyword to title if it fits
    const candidate = `${ctx.focusKeyword}: ${metaTitle}`;
    metaTitle = candidate.length <= 60 ? candidate : `${ctx.focusKeyword} — ${metaTitle}`.substring(0, 57).replace(/\s+\S*$/, '') + '…';
  }
  if (!metaDescription.toLowerCase().includes(kw)) {
    // Insert keyword naturally at start of description
    const candidate = `${ctx.focusKeyword} — ${metaDescription}`;
    metaDescription = candidate.length <= 160 ? candidate : candidate.substring(0, 157).replace(/\s+\S*$/, '') + '…';
  }
  return { ...out, metaTitle, metaDescription };
}

/** MAC-05: Inject Article JSON-LD schema if none present */
function fixMac05(ctx: FixerContext, out: FixerOutput): FixerOutput {
  const html = out.bodyHtml;
  const hasArticleSchema = /"@type"\s*:\s*"(Article|BlogPosting)"/i.test(html);
  if (hasArticleSchema) return out;

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: out.metaTitle || ctx.focusKeyword,
    url: ctx.url,
    publisher: ctx.businessName ? {
      '@type': 'Organization',
      name: ctx.businessName,
      url: ctx.websiteUrl,
    } : undefined,
  };
  const scriptTag = `\n<script type="application/ld+json">${JSON.stringify(schema, null, 2)}</script>`;
  return { ...out, bodyHtml: out.bodyHtml.trimEnd() + scriptTag };
}

/** MAC-07: Inject Organization schema if none present */
function fixMac07(ctx: FixerContext, out: FixerOutput): FixerOutput {
  if (!ctx.businessName) return out;
  if (/"@type"\s*:\s*"Organization"/i.test(out.bodyHtml)) return out;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: ctx.businessName,
    url: ctx.websiteUrl ?? ctx.url,
  };
  const scriptTag = `\n<script type="application/ld+json">${JSON.stringify(schema, null, 2)}</script>`;
  return { ...out, bodyHtml: out.bodyHtml.trimEnd() + scriptTag };
}

/** MAC-08: Inject Author/Person schema if none present */
function fixMac08(ctx: FixerContext, out: FixerOutput): FixerOutput {
  if (!ctx.authorName) return out;
  if (/"@type"\s*:\s*"Person"/i.test(out.bodyHtml)) return out;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: ctx.authorName,
    worksFor: ctx.businessName ? { '@type': 'Organization', name: ctx.businessName } : undefined,
  };
  const scriptTag = `\n<script type="application/ld+json">${JSON.stringify(schema, null, 2)}</script>`;
  return { ...out, bodyHtml: out.bodyHtml.trimEnd() + scriptTag };
}

/** MAC-09: Add internal link with exact hubKeyword anchor text */
function fixMac09(ctx: FixerContext, out: FixerOutput): FixerOutput {
  if (!ctx.hubKeyword || !ctx.internalLinks?.length) return out;
  const kw = ctx.hubKeyword.toLowerCase();
  // Already has a hub anchor?
  const anchorRe = new RegExp(`<a[^>]+>[^<]*${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^<]*<\/a>`, 'i');
  if (anchorRe.test(out.bodyHtml)) return out;
  // Find a link from internalLinks whose title contains the hub keyword
  const hubLink = ctx.internalLinks.find(l => l.title.toLowerCase().includes(kw));
  if (!hubLink) return out;
  const linkHtml = ` For a deeper look, see our guide on <a href="${hubLink.url}">${ctx.hubKeyword}</a>.`;
  // Append before the last </p> in the body
  return { ...out, bodyHtml: out.bodyHtml.replace(/(<\/p>)(?![\s\S]*<\/p>)/i, `${linkHtml}$1`) };
}

/** MAC-11: Add a sibling internal link if none present */
function fixMac11(ctx: FixerContext, out: FixerOutput): FixerOutput {
  if (!ctx.internalLinks?.length) return out;
  // Already has a sibling internal link?
  const siteHost = ctx.websiteUrl ? (() => { try { return new URL(ctx.websiteUrl).hostname; } catch { return ''; } })() : '';
  const hasInternal = new RegExp(`href=["'](\/|https?:\/\/${siteHost.replace('.', '\\.')})`, 'i').test(out.bodyHtml);
  if (hasInternal) return out;
  // Use the first available internal link
  const sibling = ctx.internalLinks[0];
  if (!sibling) return out;
  const linkHtml = ` You might also find our article on <a href="${sibling.url}">${sibling.title}</a> helpful.`;
  return { ...out, bodyHtml: out.bodyHtml.replace(/(<\/p>)(?![\s\S]*<\/p>)/i, `${linkHtml}$1`) };
}

/** MIC-01: If multiple H1s, convert extras to H2s */
function fixMic01(ctx: FixerContext, out: FixerOutput): FixerOutput {
  let count = 0;
  return {
    ...out,
    bodyHtml: out.bodyHtml.replace(/<h1([^>]*)>([\s\S]*?)<\/h1>/gi, (match, attrs, content) => {
      count++;
      if (count === 1) return match; // Keep first H1
      return `<h2${attrs}>${content}</h2>`; // Demote extra H1s
    }),
  };
}

/** MIC-02: Inject focus keyword into H1 if missing */
function fixMic02(ctx: FixerContext, out: FixerOutput): FixerOutput {
  const kw = ctx.focusKeyword.toLowerCase();
  return {
    ...out,
    bodyHtml: out.bodyHtml.replace(/<h1([^>]*)>([\s\S]*?)<\/h1>/i, (match, attrs, content) => {
      if (content.toLowerCase().includes(kw)) return match;
      return `<h1${attrs}>${ctx.focusKeyword}: ${content}</h1>`;
    }),
  };
}

/** MIC-04: Inject an H3 subheading if none exist */
function fixMic04(ctx: FixerContext, out: FixerOutput): FixerOutput {
  if (/<h3[^>]*>/i.test(out.bodyHtml)) return out;
  // Insert an H3 after the second H2's first paragraph
  let h2count = 0;
  return {
    ...out,
    bodyHtml: out.bodyHtml.replace(/(<\/p>)(\s*<h2[^>]*>)/gi, (match) => {
      h2count++;
      if (h2count === 2) {
        return match.replace(/(<\/p>)(\s*<h2[^>]*>)/, `$1\n<h3>Key Considerations</h3>\n$2`);
      }
      return match;
    }),
  };
}

/** MIC-06: Add a simple list if none exists */
function fixMic06(ctx: FixerContext, out: FixerOutput): FixerOutput {
  if (/<ul|<ol/i.test(out.bodyHtml)) return out;
  // Append a simple key-points list before the last paragraph
  const keyPoints = `\n<ul>\n  <li>Review the key concepts covered in this article.</li>\n  <li>Apply the steps that are most relevant to your situation.</li>\n  <li>Revisit regularly as best practices evolve.</li>\n</ul>\n`;
  return { ...out, bodyHtml: out.bodyHtml.replace(/(<\/p>)(?![\s\S]*<\/p>)/i, `${keyPoints}$1`) };
}

/** MIC-08: Break paragraphs exceeding ~100 words at sentence boundaries */
function fixMic08(ctx: FixerContext, out: FixerOutput): FixerOutput {
  return {
    ...out,
    bodyHtml: out.bodyHtml.replace(/<p([^>]*)>([\s\S]*?)<\/p>/gi, (match, attrs, content) => {
      const plain = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const words = plain.split(/\s+/).filter(Boolean);
      if (words.length <= 100) return match;
      // Split at a sentence boundary around word 60–80
      const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain];
      const half = Math.ceil(sentences.length / 2);
      const first = sentences.slice(0, half).join(' ').trim();
      const second = sentences.slice(half).join(' ').trim();
      if (!second) return match;
      return `<p${attrs}>${first}</p>\n<p>${second}</p>`;
    }),
  };
}

/** EAT-05: Add a .gov or .edu outbound link (only if topic lends itself) — does NOT fabricate */
function fixEat05(ctx: FixerContext, out: FixerOutput): FixerOutput {
  // Check if .gov or .edu link already exists
  if (/href=["'][^"']*\.(gov|edu)[^"']*["']/i.test(out.bodyHtml)) return out;
  // We cannot fabricate an authority link — leave failing and surface to user
  return out;
}

/** EAT-08: Remove AI buzzwords mechanically */
function fixEat08(ctx: FixerContext, out: FixerOutput): FixerOutput {
  const replacements: Record<string, string> = {
    'delve into': 'explore', 'delve': 'look', 'tapestry': 'mix', 'seamlessly': 'smoothly',
    'multifaceted': 'complex', 'nuanced': 'subtle', 'game-changer': 'major shift',
    'game changer': 'major shift', 'transformative': 'significant', 'leveraging': 'using',
    'harnessing': 'using', 'cutting-edge': 'advanced', 'streamline': 'simplify',
    'unprecedented': 'exceptional', 'paradigm': 'model', 'synergy': 'combined effect',
    'holistic': 'complete', 'empower': 'help', 'spearhead': 'lead', 'meticulous': 'careful',
    'pivotal': 'key', 'intricate': 'detailed', 'embark': 'start', 'realm': 'area',
    'fostering': 'building', 'unleash': 'release', 'elevating': 'improving',
    'revolutionize': 'transform', 'bespoke': 'custom', 'robust': 'strong',
    'leverage': 'use', 'utilize': 'use', 'utilise': 'use',
    "in today's world": 'today', "in today's fast-paced world": 'today',
    "it's important to note that": '', "it is important to note that": '',
    "it's crucial to": 'you need to', "it is crucial to": 'you need to',
    'furthermore,': 'also,', 'moreover,': 'also,', 'at the end of the day': 'ultimately',
    'in conclusion,': 'finally,', 'to summarize,': 'in short,', 'to summarise,': 'in short,',
    'dive into': 'explore',
  };

  // Work only in the text nodes, not inside HTML tags
  let html = out.bodyHtml;
  for (const [phrase, replacement] of Object.entries(replacements)) {
    const escapedPhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(
      new RegExp(`(?<=>|^)([^<]*)\\b${escapedPhrase}\\b([^<]*)(?=<|$)`, 'gi'),
      (match) => match.replace(new RegExp(escapedPhrase, 'gi'), replacement),
    );
  }
  return { ...out, bodyHtml: html };
}

// ---------------------------------------------------------------------------
// AI-powered fixers (one LLM call per failing check group)
// ---------------------------------------------------------------------------

const AI_CONTENT_CHECKS = ['MIC-03', 'MIC-05', 'EAT-02', 'EAT-03', 'EAT-04', 'EAT-07'];

async function fixAiContentChecks(
  ctx: FixerContext,
  out: FixerOutput,
  failingIds: string[],
): Promise<FixerOutput> {
  const checks = failingIds.filter(id => AI_CONTENT_CHECKS.includes(id));
  if (checks.length === 0) return out;

  const instructions: string[] = [];
  if (checks.includes('MIC-03'))
    instructions.push('MIC-03: Rewrite at least half the H2 headings to be genuine questions (ending with "?"). Keep the topic the same — just rephrase as a question the reader would ask.');
  if (checks.includes('MIC-05'))
    instructions.push('MIC-05: After each H2 heading, ensure the very first paragraph directly answers the heading question in 60 words or fewer. Trim or rewrite the first paragraph under each H2 to be a concise direct answer.');
  if (checks.includes('EAT-02'))
    instructions.push('EAT-02: Add first-hand experience phrasing to at least one paragraph. Use phrases like "we found", "in our experience", "when we tried", or "I noticed". Only add if the content is consistent with the author having direct experience — do NOT fabricate.');
  if (checks.includes('EAT-03'))
    instructions.push('EAT-03: Add a brief acknowledgment of a challenge or failed approach the author encountered. Use natural phrasing like "we initially tried X but found Y worked better". Only if consistent with existing content — do NOT fabricate.');
  if (checks.includes('EAT-04'))
    instructions.push('EAT-04: Add an attributed expert quote using a blockquote element. Format: <blockquote><p>"[quote text]" — [Expert Name], [Title/Organisation]</p></blockquote>. Only include if there is existing expert content in the article to attribute. Do NOT fabricate a quote or a person.');
  if (checks.includes('EAT-07'))
    instructions.push('EAT-07: Rewrite any passive-voice sentences to active voice. E.g. "It was found that X" → "We found X". Majority of sentences must use active voice.');

  const systemPrompt = `You are an expert blog editor. Apply ONLY the requested changes to the HTML article body — do not change anything else. Preserve all existing links, images, schema scripts, and HTML structure. Return ONLY the updated HTML with no commentary, no markdown fences, and no explanations. Write in Australian English. Do NOT fabricate statistics, quotes, people, or external links.`;

  const userPrompt = `Apply these targeted improvements to the article HTML below:

${instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n\n')}

CURRENT ARTICLE HTML:
${out.bodyHtml}`;

  try {
    const response = await invokeClaude({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const raw = (response.choices?.[0]?.message?.content ?? '') as string;
    const fixedHtml = raw
      .replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!fixedHtml) return out;
    return { ...out, bodyHtml: fixedHtml };
  } catch {
    // If AI call fails, return unchanged
    return out;
  }
}

/** MAC-06: Generate FAQPage schema from article FAQ content using AI */
async function fixMac06(ctx: FixerContext, out: FixerOutput): Promise<FixerOutput> {
  if (/"@type"\s*:\s*"FAQPage"/i.test(out.bodyHtml)) return out;

  // Extract FAQ section from HTML to check if FAQs exist at all
  const faqMatch = out.bodyHtml.match(/<h[2-3][^>]*>[^<]*(?:FAQ|frequently asked|questions)[^<]*<\/h[2-3]>([\s\S]*?)(?=<h[12]|$)/i);
  if (!faqMatch) return out; // No FAQ section — don't fabricate

  const faqSection = faqMatch[0];
  const questionMatches = faqSection.match(/<(?:h[34]|strong|b)[^>]*>(.*?)<\/(?:h[34]|strong|b)>/gi);
  if (!questionMatches || questionMatches.length === 0) return out;

  try {
    const response = await invokeClaude({
      system: 'You are an SEO schema expert. Extract FAQ questions and answers from the HTML and return valid FAQPage JSON-LD. Return ONLY the JSON — no prose, no code fences.',
      messages: [{
        role: 'user',
        content: `Extract up to 5 FAQ questions and their answers from this HTML section and return a FAQPage JSON-LD schema object:\n\n${faqSection}\n\nReturn format:\n{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"...","acceptedAnswer":{"@type":"Answer","text":"..."}}]}`,
      }],
    });
    const raw = (response.choices?.[0]?.message?.content ?? '').trim();
    if (!raw || !raw.includes('"FAQPage"')) return out;
    const scriptTag = `\n<script type="application/ld+json">${raw}</script>`;
    return { ...out, bodyHtml: out.bodyHtml.trimEnd() + scriptTag };
  } catch {
    return out;
  }
}

// ---------------------------------------------------------------------------
// Master fixer — applies all fixers for the given failing check IDs
// ---------------------------------------------------------------------------

async function applyRound(
  ctx: FixerContext,
  out: FixerOutput,
  failingIds: string[],
): Promise<FixerOutput> {
  // Deterministic fixers (no LLM)
  if (failingIds.includes('MAC-02')) out = fixMac02(ctx, out);
  if (failingIds.includes('MAC-03')) out = fixMac03(ctx, out);
  if (failingIds.includes('MAC-04')) out = fixMac04(ctx, out);
  if (failingIds.includes('MAC-05')) out = fixMac05(ctx, out);
  if (failingIds.includes('MAC-07')) out = fixMac07(ctx, out);
  if (failingIds.includes('MAC-08')) out = fixMac08(ctx, out);
  if (failingIds.includes('MAC-09')) out = fixMac09(ctx, out);
  if (failingIds.includes('MAC-11')) out = fixMac11(ctx, out);
  if (failingIds.includes('MIC-01')) out = fixMic01(ctx, out);
  if (failingIds.includes('MIC-02')) out = fixMic02(ctx, out);
  if (failingIds.includes('MIC-04')) out = fixMic04(ctx, out);
  if (failingIds.includes('MIC-06')) out = fixMic06(ctx, out);
  if (failingIds.includes('MIC-08')) out = fixMic08(ctx, out);
  if (failingIds.includes('EAT-08')) out = fixEat08(ctx, out);

  // Schema fixers (small AI call each)
  if (failingIds.includes('MAC-06')) out = await fixMac06(ctx, out);

  // Grouped AI content fixer (single call for all content checks)
  out = await fixAiContentChecks(ctx, out, failingIds);

  return out;
}

// ---------------------------------------------------------------------------
// applyFixers — main entry point
// ---------------------------------------------------------------------------

export async function applyFixers(
  ctx: FixerContext,
  mode: 'adjust' | 'refresh' = 'adjust',
): Promise<FixerResult> {
  const MAX_ROUNDS = mode === 'adjust' ? 3 : 1;
  const TARGET_SCORE = 90;

  // Surface unfixable checks to user
  const surfaceToUser: FixerResult['surfaceToUser'] = [];

  // Build initial output from context
  let out: FixerOutput = {
    bodyHtml: ctx.bodyHtml,
    metaTitle: ctx.metaTitle,
    metaDescription: ctx.metaDescription,
    schemaJson: ctx.schemaJson ?? null,
  };

  // Build audit input (reused every round)
  const auditInput: PostAuditInput = {
    bodyHtml: out.bodyHtml,
    focusKeyword: ctx.focusKeyword,
    url: ctx.url,
    metaTitle: out.metaTitle,
    metaDescription: out.metaDescription,
    hubKeyword: ctx.hubKeyword,
    isHub: ctx.isHub,
    liveChecks: ctx.liveChecks,
    schemaJson: out.schemaJson,
    primaryCtaUrl: ctx.primaryCtaUrl,
  };

  // Run initial audit
  let auditResult = await runFullAudit(auditInput);
  let rounds = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (auditResult.normalized_score >= TARGET_SCORE) break;

    const failingIds = auditResult.failed_checks.map(c => c.id);
    if (failingIds.length === 0) break;

    // Log unfixable checks on first round
    if (round === 0) {
      for (const id of failingIds) {
        if (UNFIXABLE[id]) {
          surfaceToUser.push({
            id,
            parameter: auditResult.checks.find(c => c.id === id)?.parameter ?? id,
            reason: UNFIXABLE[id],
          });
        }
      }
    }

    // Apply fixers for this round
    out = await applyRound(ctx, out, failingIds.filter(id => !UNFIXABLE[id]));
    rounds++;

    // Re-audit with updated output
    auditResult = await runFullAudit({
      ...auditInput,
      bodyHtml: out.bodyHtml,
      metaTitle: out.metaTitle,
      metaDescription: out.metaDescription,
      schemaJson: out.schemaJson,
    });
  }

  return {
    output: out,
    finalAuditResult: auditResult,
    rounds,
    surfaceToUser,
  };
}
