/**
 * bloginatorAudit.ts — Synchronous 29-check / 100-point SEO audit engine.
 *
 * Single source of truth shared by iAudit and Blog Batcher.
 * All checks are deterministic/regex — no LLM calls, no async.
 * EAT content checks (EAT-01–04, EAT-07) use heuristic pattern matching.
 *
 * Entry point:  auditHtml(params) → AuditResultSync
 * Also exports: AUDIT_RULES, AUDIT_MAX_POINTS
 */

// ---------------------------------------------------------------------------
// Rule definitions
// ---------------------------------------------------------------------------

export interface AuditRule {
  id: string;
  parameter: string;
  phase: "macro" | "micro" | "eat";
  maxPoints: number;
}

export const AUDIT_RULES: AuditRule[] = [
  // Macro Architecture — 40 pts
  { id: "MAC-01", parameter: "URL Silo",                                    phase: "macro", maxPoints: 3 },
  { id: "MAC-02", parameter: "Meta Title Length",                           phase: "macro", maxPoints: 2 },
  { id: "MAC-03", parameter: "Meta Description Length",                     phase: "macro", maxPoints: 1 },
  { id: "MAC-04", parameter: "Keyword in Meta Title & Description",         phase: "macro", maxPoints: 4 },
  { id: "MAC-05", parameter: "Article / BlogPosting Schema",                phase: "macro", maxPoints: 3 },
  { id: "MAC-06", parameter: "FAQPage Schema",                              phase: "macro", maxPoints: 4 },
  { id: "MAC-07", parameter: "Organization Schema",                         phase: "macro", maxPoints: 2 },
  { id: "MAC-08", parameter: "Author / Person Schema",                      phase: "macro", maxPoints: 3 },
  { id: "MAC-09", parameter: "Internal Pillar Link (hub keyword in anchor)", phase: "macro", maxPoints: 5 },
  { id: "MAC-10", parameter: "Internal Child Link (hub pages only)",        phase: "macro", maxPoints: 2 },
  { id: "MAC-11", parameter: "Internal Sibling Link",                       phase: "macro", maxPoints: 2 },
  { id: "MAC-12", parameter: "Core Web Vitals Pass",                        phase: "macro", maxPoints: 4 },
  { id: "MAC-13", parameter: "llms.txt Present",                            phase: "macro", maxPoints: 5 },
  // Micro Architecture — 35 pts
  { id: "MIC-01", parameter: "Exactly One H1",                             phase: "micro", maxPoints: 3 },
  { id: "MIC-02", parameter: "Focus Keyword in H1",                        phase: "micro", maxPoints: 5 },
  { id: "MIC-03", parameter: "H2s Are Questions (≥ 50%)",                  phase: "micro", maxPoints: 5 },
  { id: "MIC-04", parameter: "At Least One H3",                            phase: "micro", maxPoints: 3 },
  { id: "MIC-05", parameter: "Direct Answer After H2 (≤ 60 words)",        phase: "micro", maxPoints: 5 },
  { id: "MIC-06", parameter: "List Present (ul or ol)",                    phase: "micro", maxPoints: 5 },
  { id: "MIC-07", parameter: "Comparison Data (table or bold-label list)", phase: "micro", maxPoints: 4 },
  { id: "MIC-08", parameter: "No Paragraph Exceeds ~100 Words",            phase: "micro", maxPoints: 5 },
  // E-E-A-T & Voice — 25 pts
  { id: "EAT-01", parameter: "Concrete Stats / Case Study Data",           phase: "eat",   maxPoints: 5 },
  { id: "EAT-02", parameter: "First-Hand Experience Phrasing",             phase: "eat",   maxPoints: 4 },
  { id: "EAT-03", parameter: "Acknowledges Failed Approach",               phase: "eat",   maxPoints: 2 },
  { id: "EAT-04", parameter: "Attributed Expert Blockquote",               phase: "eat",   maxPoints: 4 },
  { id: "EAT-05", parameter: "Outbound Link to .gov or .edu",             phase: "eat",   maxPoints: 3 },
  { id: "EAT-06", parameter: "Two Unique External Domains",                phase: "eat",   maxPoints: 2 },
  { id: "EAT-07", parameter: "Majority Active Voice",                      phase: "eat",   maxPoints: 2 },
  { id: "EAT-08", parameter: "No AI Buzzwords",                            phase: "eat",   maxPoints: 3 },
];

export const AUDIT_MAX_POINTS = AUDIT_RULES.reduce((s, r) => s + r.maxPoints, 0); // 100

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface AuditHtmlParams {
  html: string;
  primaryKeyword: string;
  url?: string;
  hubKeyword?: string | null;
  isHub?: boolean;
  metaTitle?: string | null;
  metaDescription?: string | null;
  liveChecks?: {
    coreWebVitalsPass?: boolean;
    llmsTxtPresent?: boolean;
  };
}

export interface AuditCheckResult {
  id: string;
  parameter: string;
  phase: "macro" | "micro" | "eat";
  passed: boolean | null; // null = not applicable
  points: number;
  maxPoints: number;
  detail: string;
}

export interface AuditResultSync {
  normalized_score: number;
  total_score: number;
  applicable_max: number;
  checks: AuditCheckResult[];
  failed_checks: { id: string; parameter: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasKeyword(text: string, kw: string): boolean {
  return norm(text).includes(norm(kw));
}

/** Extract content of headings at a given level (1-6) */
function extractHeadings(html: string, level: number): string[] {
  const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.push(stripTags(m[1]));
  return out;
}

/** Extract all <p> text content */
function extractParagraphs(html: string): string[] {
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[1]).trim();
    if (text) out.push(text);
  }
  return out;
}

/** Is this heading text a question? */
function isQuestion(text: string): boolean {
  if (text.trim().endsWith("?")) return true;
  return /^(what|how|why|is|are|can|should|does|do|when|where|which|who)\b/i.test(text.trim());
}

/** Extract unique external domains from HTML */
function extractExternalDomains(html: string, siteUrl?: string): string[] {
  const re = /href=["']https?:\/\/([^"'/?#]+)/gi;
  const domains = new Set<string>();
  let siteDomain = "";
  if (siteUrl) {
    try { siteDomain = new URL(siteUrl).hostname; } catch { /* ignore */ }
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const domain = m[1].toLowerCase();
    if (!siteDomain || (domain !== siteDomain && !domain.endsWith("." + siteDomain))) {
      domains.add(domain);
    }
  }
  return [...domains];
}

/** Get plain text of the first paragraph immediately following a given h2 index */
function firstParaAfterH2(html: string, h2Index: number): string {
  // Find all H2 start positions
  const h2Re = /<h2[^>]*>[\s\S]*?<\/h2>/gi;
  const h2Positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = h2Re.exec(html)) !== null) h2Positions.push(m.index + m[0].length);

  const startPos = h2Positions[h2Index];
  if (startPos === undefined) return "";

  const endPos = h2Positions[h2Index + 1] ?? html.length;
  const section = html.slice(startPos, endPos);

  // First <p> in section
  const pMatch = section.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return pMatch ? stripTags(pMatch[1]) : "";
}

const AI_BUZZWORDS = [
  "delve into", "delve", "tapestry", "seamlessly", "multifaceted", "nuanced",
  "game-changer", "game changer", "transformative", "leveraging", "harnessing",
  "cutting-edge", "streamline", "unprecedented", "paradigm", "synergy", "holistic",
  "empower", "spearhead", "meticulous", "pivotal", "intricate", "embark", "realm",
  "fostering", "unleash", "elevating", "revolutionize", "bespoke", "robust solution",
  "leverage", "in today's fast-paced", "in today's world", "in today's digital",
  "it's worth noting", "it is worth noting", "moreover,", "furthermore,",
];

// ---------------------------------------------------------------------------
// Main audit function
// ---------------------------------------------------------------------------

export function auditHtml(params: AuditHtmlParams): AuditResultSync {
  const { html, primaryKeyword, url, hubKeyword, isHub, liveChecks } = params;
  const kw = primaryKeyword;

  // Parse meta title and description from HTML if not provided
  const metaTitleRaw = params.metaTitle
    ?? (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const metaDescRaw = params.metaDescription
    ?? (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
        ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1]
        ?? "");

  const metaTitle = stripTags(metaTitleRaw).trim();
  const metaDescription = stripTags(metaDescRaw).trim();

  const checks: AuditCheckResult[] = [];

  function pass(id: string, detail: string) {
    const rule = AUDIT_RULES.find(r => r.id === id)!;
    checks.push({ id, parameter: rule.parameter, phase: rule.phase, passed: true, points: rule.maxPoints, maxPoints: rule.maxPoints, detail });
  }
  function fail(id: string, detail: string) {
    const rule = AUDIT_RULES.find(r => r.id === id)!;
    checks.push({ id, parameter: rule.parameter, phase: rule.phase, passed: false, points: 0, maxPoints: rule.maxPoints, detail });
  }
  function na(id: string, detail = "Not applicable") {
    const rule = AUDIT_RULES.find(r => r.id === id)!;
    checks.push({ id, parameter: rule.parameter, phase: rule.phase, passed: null, points: 0, maxPoints: rule.maxPoints, detail });
  }

  // ── MACRO ARCHITECTURE ─────────────────────────────────────────────────────

  // MAC-01: URL silo — subdirectories, no date patterns
  if (url) {
    let slug = "";
    try { slug = new URL(url).pathname; } catch { slug = url; }
    const hasDate = /\/\d{4}(\/\d{2})?(\/\d{2})?\//i.test(slug) || /\/\d{4}-\d{2}-\d{2}\//i.test(slug);
    const hasSub = (slug.split("/").filter(Boolean).length >= 2);
    hasDate ? fail("MAC-01", "URL contains a date segment.") : hasSub ? pass("MAC-01", "URL uses subdirectory silo with no date.") : fail("MAC-01", "URL has no subdirectory structure.");
  } else {
    na("MAC-01", "No URL provided.");
  }

  // MAC-02: Meta title ≤ 60 chars
  metaTitle.length > 0 && metaTitle.length <= 60
    ? pass("MAC-02", `Meta title is ${metaTitle.length} chars.`)
    : fail("MAC-02", metaTitle.length === 0 ? "No meta title found." : `Meta title is ${metaTitle.length} chars (max 60).`);

  // MAC-03: Meta description ≤ 160 chars
  metaDescription.length > 0 && metaDescription.length <= 160
    ? pass("MAC-03", `Meta description is ${metaDescription.length} chars.`)
    : fail("MAC-03", metaDescription.length === 0 ? "No meta description found." : `Meta description is ${metaDescription.length} chars (max 160).`);

  // MAC-04: Keyword in both meta title AND description
  const kwInTitle = hasKeyword(metaTitle, kw);
  const kwInDesc  = hasKeyword(metaDescription, kw);
  kwInTitle && kwInDesc
    ? pass("MAC-04", "Keyword found in meta title and description.")
    : fail("MAC-04", !kwInTitle && !kwInDesc ? "Keyword missing from both title and description." : !kwInTitle ? "Keyword missing from meta title." : "Keyword missing from meta description.");

  // MAC-05: Article / BlogPosting schema
  /"@type"\s*:\s*"(Article|BlogPosting)"/i.test(html)
    ? pass("MAC-05", "Article/BlogPosting schema found.")
    : fail("MAC-05", "No Article or BlogPosting schema found.");

  // MAC-06: FAQPage schema
  /"@type"\s*:\s*"FAQPage"/i.test(html)
    ? pass("MAC-06", "FAQPage schema found.")
    : fail("MAC-06", "No FAQPage schema found.");

  // MAC-07: Organization schema
  /"@type"\s*:\s*"Organization"/i.test(html)
    ? pass("MAC-07", "Organization schema found.")
    : fail("MAC-07", "No Organization schema found.");

  // MAC-08: Author / Person schema
  /"@type"\s*:\s*"Person"/i.test(html)
    ? pass("MAC-08", "Person/Author schema found.")
    : fail("MAC-08", "No Person/Author schema found.");

  // MAC-09: Internal link with hub keyword in anchor text
  if (hubKeyword) {
    const hubNorm = norm(hubKeyword);
    const anchorRe = /<a[^>]+href=["'][^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
    let found = false;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null) {
      if (norm(stripTags(m[1])).includes(hubNorm)) { found = true; break; }
    }
    found ? pass("MAC-09", `Internal link with hub keyword "${hubKeyword}" found.`) : fail("MAC-09", `No internal link with anchor text containing "${hubKeyword}".`);
  } else {
    na("MAC-09", "No hub keyword provided.");
  }

  // MAC-10: Internal child links (hub pages only)
  if (isHub === true) {
    const internalLinks = (html.match(/<a[^>]+href=["'](\/[^"']+)["']/gi) ?? []).length;
    internalLinks >= 1
      ? pass("MAC-10", `Hub page has ${internalLinks} internal child link(s).`)
      : fail("MAC-10", "Hub page has no internal child links.");
  } else {
    na("MAC-10", "Not a hub page.");
  }

  // MAC-11: Internal sibling link (any internal link to another page)
  const currentPath = (() => { try { return new URL(url ?? "").pathname; } catch { return ""; } })();
  const siblingRe = /<a[^>]+href=["'](\/[^"']+)["']/gi;
  let siblingFound = false;
  let sm: RegExpExecArray | null;
  while ((sm = siblingRe.exec(html)) !== null) {
    if (sm[1] !== currentPath) { siblingFound = true; break; }
  }
  siblingFound ? pass("MAC-11", "Internal sibling link found.") : fail("MAC-11", "No internal sibling link found.");

  // MAC-12: Core Web Vitals (live check)
  if (liveChecks?.coreWebVitalsPass !== undefined) {
    liveChecks.coreWebVitalsPass ? pass("MAC-12", "Core Web Vitals pass.") : fail("MAC-12", "Core Web Vitals failing.");
  } else {
    na("MAC-12", "Live check not run.");
  }

  // MAC-13: llms.txt (live check)
  if (liveChecks?.llmsTxtPresent !== undefined) {
    liveChecks.llmsTxtPresent ? pass("MAC-13", "llms.txt present.") : fail("MAC-13", "llms.txt not found.");
  } else {
    na("MAC-13", "Live check not run.");
  }

  // ── MICRO ARCHITECTURE ─────────────────────────────────────────────────────

  const h1s = extractHeadings(html, 1);
  const h2s = extractHeadings(html, 2);
  const h3s = extractHeadings(html, 3);
  const paras = extractParagraphs(html);

  // MIC-01: Exactly one H1
  h1s.length === 1 ? pass("MIC-01", "Exactly one H1.") : fail("MIC-01", `Found ${h1s.length} H1s — must be exactly one.`);

  // MIC-02: Keyword in H1
  h1s.some(h => hasKeyword(h, kw)) ? pass("MIC-02", "Focus keyword found in H1.") : fail("MIC-02", "Focus keyword not found in any H1.");

  // MIC-03: ≥ 50% of H2s are questions
  if (h2s.length === 0) {
    fail("MIC-03", "No H2 headings found.");
  } else {
    const questionH2s = h2s.filter(isQuestion).length;
    const pct = questionH2s / h2s.length;
    pct >= 0.5
      ? pass("MIC-03", `${questionH2s}/${h2s.length} H2s are questions (${Math.round(pct * 100)}%).`)
      : fail("MIC-03", `Only ${questionH2s}/${h2s.length} H2s are questions (need ≥ 50%).`);
  }

  // MIC-04: At least one H3
  h3s.length >= 1 ? pass("MIC-04", `${h3s.length} H3 heading(s) found.`) : fail("MIC-04", "No H3 headings found.");

  // MIC-05: First paragraph after each H2 ≤ 60 words
  if (h2s.length === 0) {
    fail("MIC-05", "No H2 headings to check.");
  } else {
    let allShort = true;
    let worst = 0;
    for (let i = 0; i < h2s.length; i++) {
      const firstPara = firstParaAfterH2(html, i);
      if (!firstPara) continue;
      const wc = wordCount(firstPara);
      if (wc > 60) { allShort = false; worst = Math.max(worst, wc); }
    }
    allShort ? pass("MIC-05", "Each H2 is followed by a direct answer of ≤ 60 words.") : fail("MIC-05", `At least one H2 is followed by a paragraph of ${worst} words (max 60).`);
  }

  // MIC-06: List present
  /<ul|<ol/i.test(html) ? pass("MIC-06", "List element found.") : fail("MIC-06", "No <ul> or <ol> found.");

  // MIC-07: Table OR bold-label list (li starting with strong/b)
  const hasTable = /<table/i.test(html);
  const hasBoldLabelList = /<li[^>]*>\s*<(?:strong|b)[^>]*>/i.test(html);
  hasTable || hasBoldLabelList
    ? pass("MIC-07", hasTable ? "Comparison table found." : "Bold-label list found.")
    : fail("MIC-07", "No comparison table or bold-label list found.");

  // MIC-08: No paragraph over ~100 words
  const longParas = paras.filter(p => wordCount(p) > 100);
  longParas.length === 0
    ? pass("MIC-08", "All paragraphs are within the 100-word limit.")
    : fail("MIC-08", `${longParas.length} paragraph(s) exceed 100 words (longest: ${Math.max(...longParas.map(wordCount))} words).`);

  // ── E-E-A-T & VOICE ────────────────────────────────────────────────────────

  const bodyText = stripTags(html);

  // EAT-01: Concrete stats / case study data
  const statPatterns = [
    /\b\d[\d,]*(\.\d+)?\s*(million|billion|thousand|%|percent|dollars?|USD|AUD|years?|months?|weeks?)\b/i,
    /\b\d+\s+(businesses|clients|companies|users|people|customers|respondents|studies)\b/i,
    /\b(increased|decreased|grew|reduced|improved|saved|generated)\s+by\s+\d/i,
    /\$\d[\d,]*(\.\d+)?/,
    /\b\d[\d,]*\s*(–|-)\s*\d[\d,]*\s*(dollars?|AUD|USD|percent|%)/i,
  ];
  statPatterns.some(p => p.test(bodyText))
    ? pass("EAT-01", "Concrete statistics or data found.")
    : fail("EAT-01", "No concrete stats, numbers, or case study data found.");

  // EAT-02: First-hand experience phrasing
  const expPhrases = [
    /\b(in our experience|in my experience|we (found|discovered|noticed|tested|tried|learned|learnt)|I (found|noticed|tested|tried|learned|learnt)|when (we|I) (tried|tested|ran|worked)\b)/i,
    /\bour (team|clients?|work)\b.{0,60}\b(found|noticed|saw|discovered|tested)\b/i,
    /\b(we've|we have|i've|I have) (seen|found|noticed|tested|tried)\b/i,
  ];
  expPhrases.some(p => p.test(bodyText))
    ? pass("EAT-02", "First-hand experience phrasing found.")
    : fail("EAT-02", "No first-hand experience phrasing detected.");

  // EAT-03: Acknowledges failed approach or mistake
  const failPhrases = [
    /\b(common mistake|a mistake|didn'?t work|doesn'?t work|failed|we initially tried|avoid this|watch out for|pitfall|wrong approach|what not to do)\b/i,
    /\b(we (used to|initially|first tried|found that [^.]+didn'?t))\b/i,
  ];
  failPhrases.some(p => p.test(bodyText))
    ? pass("EAT-03", "Acknowledges a failed approach or mistake.")
    : fail("EAT-03", "No acknowledgment of a failed approach or mistake found.");

  // EAT-04: Attributed expert blockquote
  const hasBlockquote = /<blockquote/i.test(html);
  const hasAttribution = /[""][^""]+[""][\s\S]{0,80}(—|-|–)\s*[A-Z][a-z]/i.test(bodyText)
    || /according to\s+[A-Z][a-z]+\s+[A-Z][a-z]+/i.test(bodyText);
  hasBlockquote || hasAttribution
    ? pass("EAT-04", "Attributed expert blockquote or quote found.")
    : fail("EAT-04", "No attributed expert blockquote or quote found.");

  // EAT-05: Outbound .gov or .edu link
  const govEduRe = /href=["']https?:\/\/[^"']*\.(gov|edu)(\.[a-z]{2,3})?(\/[^"']*)?["']/i;
  govEduRe.test(html)
    ? pass("EAT-05", ".gov or .edu outbound link found.")
    : fail("EAT-05", "No outbound .gov or .edu link found.");

  // EAT-06: Two unique external domains
  const externalDomains = extractExternalDomains(html, url);
  externalDomains.length >= 2
    ? pass("EAT-06", `${externalDomains.length} unique external domains linked.`)
    : fail("EAT-06", `Only ${externalDomains.length} unique external domain(s) found (need ≥ 2).`);

  // EAT-07: Majority active voice (heuristic — detect passive "be + past participle + by" constructions)
  const sentences = bodyText.match(/[^.!?]+[.!?]+/g) ?? [];
  const passiveRe = /\b(is|are|was|were|be|been|being)\s+\w+(ed|en)\b(\s+by\b)?/i;
  const passiveCount = sentences.filter(s => passiveRe.test(s)).length;
  const passivePct = sentences.length > 0 ? passiveCount / sentences.length : 0;
  passivePct < 0.5
    ? pass("EAT-07", `${Math.round((1 - passivePct) * 100)}% of sentences are active voice.`)
    : fail("EAT-07", `${Math.round(passivePct * 100)}% of sentences are passive voice (majority must be active).`);

  // EAT-08: No AI buzzwords
  const foundBuzzwords = AI_BUZZWORDS.filter(bw => new RegExp(`\\b${bw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(bodyText));
  foundBuzzwords.length === 0
    ? pass("EAT-08", "No AI buzzwords detected.")
    : fail("EAT-08", `AI buzzwords found: ${foundBuzzwords.slice(0, 5).join(", ")}${foundBuzzwords.length > 5 ? ` (+${foundBuzzwords.length - 5} more)` : ""}.`);

  // ── SCORE ──────────────────────────────────────────────────────────────────

  const total_score    = checks.reduce((s, c) => s + c.points, 0);
  const applicable_max = checks.filter(c => c.passed !== null).reduce((s, c) => s + c.maxPoints, 0);
  const normalized_score = applicable_max > 0 ? Math.round((total_score / applicable_max) * 100) : 0;

  const failed_checks = checks
    .filter(c => c.passed === false)
    .map(c => ({ id: c.id, parameter: c.parameter }));

  return { normalized_score, total_score, applicable_max, checks, failed_checks };
}
