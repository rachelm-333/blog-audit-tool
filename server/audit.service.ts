/**
 * iAudit — Audit Engine Service
 *
 * Implements the 29-Check / 100-Point Authority Standard scoring engine.
 *
 * Macro Architecture (40 pts): MAC-01 through MAC-13
 * Micro Architecture (35 pts): MIC-01 through MIC-08
 * E-E-A-T & Voice (25 pts):   EAT-01 through EAT-08
 */

import { invokeClaude } from "./_core/claude";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuditPointStatus = "pass" | "fail" | "na" | "unable_to_score";

/** Backward-compat point shape used by the UI */
export interface AuditPoint {
  point: string; // e.g. "MAC-01"
  name: string;
  status: AuditPointStatus;
  note: string;
}

export interface AuditCheck {
  id: string;
  parameter: string;
  phase: 'macro' | 'micro' | 'eat';
  passed: boolean | null; // null = N/A
  points: number;
  maxPoints: number;
  detail: string;
}

export interface AuditResult {
  normalized_score: number;
  total_score: number;
  applicable_max: number;
  checks: AuditCheck[];
  failed_checks: { id: string; parameter: string }[];
  score: number; // = normalized_score (backward compat)
  grade: string;
  points: AuditPoint[]; // backward compat — mapped from checks
  potentialScore: number; // = applicable_max (backward compat)
}

export interface PostAuditInput {
  bodyHtml: string;
  pageSource?: string | null; // full page HTML including <head> — used for schema detection
  focusKeyword: string | null;
  url: string;
  metaTitle: string | null;
  metaDescription: string | null;
  hubKeyword?: string | null;
  isHub?: boolean;
  liveChecks?: { coreWebVitalsPass?: boolean; llmsTxtPresent?: boolean };
  schemaJson?: object | null;
  primaryCtaUrl?: string | null;
  secondaryCtaUrls?: string[];
}

// ---------------------------------------------------------------------------
// Check definitions (id, parameter, phase, maxPoints)
// ---------------------------------------------------------------------------

interface CheckDef {
  id: string;
  parameter: string;
  phase: 'macro' | 'micro' | 'eat';
  maxPoints: number;
}

const CHECK_DEFS: CheckDef[] = [
  // Macro Architecture — 40 pts
  { id: 'MAC-01', parameter: 'URL Silo',                         phase: 'macro', maxPoints: 3 },
  { id: 'MAC-02', parameter: 'Meta Title Length',                phase: 'macro', maxPoints: 2 },
  { id: 'MAC-03', parameter: 'Meta Description Length',          phase: 'macro', maxPoints: 1 },
  { id: 'MAC-04', parameter: 'Keyword in Meta Title & Description', phase: 'macro', maxPoints: 4 },
  { id: 'MAC-05', parameter: 'Article / BlogPosting Schema',     phase: 'macro', maxPoints: 3 },
  { id: 'MAC-06', parameter: 'FAQPage Schema',                   phase: 'macro', maxPoints: 4 },
  { id: 'MAC-07', parameter: 'Organization Schema',              phase: 'macro', maxPoints: 2 },
  { id: 'MAC-08', parameter: 'Author / Person Schema',           phase: 'macro', maxPoints: 3 },
  { id: 'MAC-09', parameter: 'Internal Pillar Link (hub keyword in anchor)', phase: 'macro', maxPoints: 5 },
  { id: 'MAC-10', parameter: 'Internal Child Link (hub pages only)', phase: 'macro', maxPoints: 2 },
  { id: 'MAC-11', parameter: 'Internal Sibling Link',            phase: 'macro', maxPoints: 2 },
  { id: 'MAC-12', parameter: 'Core Web Vitals Pass',             phase: 'macro', maxPoints: 4 },
  { id: 'MAC-13', parameter: 'llms.txt Present',                 phase: 'macro', maxPoints: 5 },
  // Micro Architecture — 35 pts
  { id: 'MIC-01', parameter: 'Exactly One H1',                   phase: 'micro', maxPoints: 3 },
  { id: 'MIC-02', parameter: 'Focus Keyword in H1',              phase: 'micro', maxPoints: 5 },
  { id: 'MIC-03', parameter: 'H2s Are Questions (≥ 50%)',        phase: 'micro', maxPoints: 5 },
  { id: 'MIC-04', parameter: 'At Least One H3',                  phase: 'micro', maxPoints: 3 },
  { id: 'MIC-05', parameter: 'Direct Answer After H2 (≤ 60 words)', phase: 'micro', maxPoints: 5 },
  { id: 'MIC-06', parameter: 'List Present (ul or ol)',          phase: 'micro', maxPoints: 5 },
  { id: 'MIC-07', parameter: 'Comparison Data (table or bold-label list)', phase: 'micro', maxPoints: 4 },
  { id: 'MIC-08', parameter: 'No Paragraph Exceeds ~100 Words',  phase: 'micro', maxPoints: 5 },
  // E-E-A-T & Voice — 25 pts
  { id: 'EAT-01', parameter: 'Concrete Stats / Case Study Data', phase: 'eat', maxPoints: 5 },
  { id: 'EAT-02', parameter: 'First-Hand Experience Phrasing',   phase: 'eat', maxPoints: 4 },
  { id: 'EAT-03', parameter: 'Acknowledges Failed Approach',     phase: 'eat', maxPoints: 2 },
  { id: 'EAT-04', parameter: 'Attributed Expert Blockquote',     phase: 'eat', maxPoints: 4 },
  { id: 'EAT-05', parameter: 'Outbound Link to .gov or .edu',   phase: 'eat', maxPoints: 3 },
  { id: 'EAT-06', parameter: 'Two Unique External Domains',      phase: 'eat', maxPoints: 2 },
  { id: 'EAT-07', parameter: 'Majority Active Voice',            phase: 'eat', maxPoints: 2 },
  { id: 'EAT-08', parameter: 'No AI Buzzwords',                  phase: 'eat', maxPoints: 3 },
];

const CHECK_DEF_MAP = new Map(CHECK_DEFS.map(d => [d.id, d]));

// ---------------------------------------------------------------------------
// Helpers (kept from original for compatibility)
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

/** Check if text contains the keyword (case-insensitive) */
function containsKeyword(text: string, keyword: string): boolean {
  return normalise(text).includes(normalise(keyword));
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

/** Extract all external links from HTML as a plain list */
export function extractExternalLinks(html: string, siteUrl?: string): string[] {
  const links: string[] = [];
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href.startsWith('http')) continue;
    if (siteUrl) {
      try {
        const linkDomain = new URL(href).hostname;
        const siteDomain = new URL(siteUrl).hostname;
        if (linkDomain === siteDomain || linkDomain.endsWith('.' + siteDomain)) continue;
      } catch { /* ignore malformed URLs */ }
    }
    const anchor = m[2].replace(/<[^>]+>/g, '').trim();
    links.push(`${anchor} → ${href}`);
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
      path = href;
    } else if (href.startsWith('http')) {
      try {
        const u = new URL(href);
        if (u.hostname !== siteDomain && !u.hostname.endsWith('.' + siteDomain)) continue;
        path = u.pathname;
      } catch { continue; }
    } else {
      continue;
    }
    if (currentPath && path === currentPath) continue;
    links.push({ anchor, href, path });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Grade helper
// ---------------------------------------------------------------------------

export function scoreToGrade(
  score: number
): "optimised" | "strong" | "needs_work" | "poor" | "critical" {
  if (score >= 90) return "optimised";
  if (score >= 75) return "strong";
  if (score >= 60) return "needs_work";
  if (score >= 40) return "poor";
  return "critical";
}

// ---------------------------------------------------------------------------
// AI buzzwords list (EAT-08)
// ---------------------------------------------------------------------------

const AI_BUZZWORDS = [
  'delve', 'tapestry', 'seamlessly', 'multifaceted', 'nuanced', 'game-changer',
  'transformative', 'leveraging', 'harnessing', 'cutting-edge', 'streamline',
  'unprecedented', 'paradigm', 'synergy', 'holistic', 'empower', 'spearhead',
  'meticulous', 'crucial', 'pivotal', 'intricate', 'embark', 'realm',
  'fostering', 'unleash', 'elevating', 'revolutionize', 'bespoke',
];

// Question starters for MIC-03
const QUESTION_STARTERS = /^(what|how|why|is|are|can|should|does|do|when|where|which)\b/i;

// ---------------------------------------------------------------------------
// Build a single AuditCheck from raw data
// ---------------------------------------------------------------------------

function makeCheck(
  id: string,
  passed: boolean | null,
  detail: string
): AuditCheck {
  const def = CHECK_DEF_MAP.get(id)!;
  const points = passed === true ? def.maxPoints : 0;
  return {
    id,
    parameter: def.parameter,
    phase: def.phase,
    passed,
    points,
    maxPoints: def.maxPoints,
    detail,
  };
}

// ---------------------------------------------------------------------------
// Run all mechanical checks (MAC + MIC + mechanical EAT)
// Returns AuditCheck[] for those checks
// ---------------------------------------------------------------------------

function runMechanicalCheckItems(input: PostAuditInput): AuditCheck[] {
  const { bodyHtml, pageSource, focusKeyword, url, metaTitle, metaDescription, hubKeyword, isHub, liveChecks, schemaJson } = input;
  const schemaSource = pageSource || bodyHtml; // prefer full page HTML for schema detection
  const results: AuditCheck[] = [];

  const bodyText = stripHtml(bodyHtml);
  const siteUrl = url?.trim() ? (() => { try { return new URL(url).origin; } catch { return ''; } })() : '';

  // ── MAC-01: URL silo (no date patterns in path) ──────────────────────────
  {
    const slug = extractSlug(url ?? '');
    const hasDatePattern = /\/\d{4}\/\d{2}\/\d{2}\//.test(slug) ||    // YYYY/MM/DD
                           /\/\d{4}\/\d{2}\//.test(slug) ||            // YYYY/MM
                           /\/20\d{2}\//.test(slug);                   // /2024/, /2025/ etc
    results.push(makeCheck('MAC-01',
      !url?.trim() ? null : !hasDatePattern,
      !url?.trim()
        ? 'URL not available — unable to check.'
        : hasDatePattern
          ? `Date pattern found in URL: ${slug}. Use subdirectory-based URLs without dates.`
          : `URL path is clean: ${slug}`
    ));
  }

  // ── MAC-02: Meta title ≤ 60 chars ────────────────────────────────────────
  {
    const mt = metaTitle?.trim() ?? '';
    results.push(makeCheck('MAC-02',
      mt.length > 0 && mt.length <= 60,
      !mt.length
        ? 'Meta title is missing.'
        : mt.length > 60
          ? `Meta title is ${mt.length} chars — exceeds 60-char limit.`
          : `Meta title is ${mt.length} chars — within limit.`
    ));
  }

  // ── MAC-03: Meta description ≤ 160 chars ─────────────────────────────────
  {
    const md = metaDescription?.trim() ?? '';
    results.push(makeCheck('MAC-03',
      md.length > 0 && md.length <= 160,
      !md.length
        ? 'Meta description is missing.'
        : md.length > 160
          ? `Meta description is ${md.length} chars — exceeds 160-char limit.`
          : `Meta description is ${md.length} chars — within limit.`
    ));
  }

  // ── MAC-04: Keyword in both meta title AND meta description ──────────────
  {
    if (!focusKeyword) {
      results.push(makeCheck('MAC-04', false, 'No focus keyword set.'));
    } else {
      const mt = metaTitle?.trim() ?? '';
      const md = metaDescription?.trim() ?? '';
      const inTitle = containsKeyword(mt, focusKeyword);
      const inDesc = containsKeyword(md, focusKeyword);
      const passed = inTitle && inDesc;
      results.push(makeCheck('MAC-04',
        passed,
        passed
          ? 'Keyword found in both meta title and description.'
          : !inTitle && !inDesc
            ? 'Keyword missing from both meta title and description.'
            : !inTitle
              ? 'Keyword missing from meta title.'
              : 'Keyword missing from meta description.'
      ));
    }
  }

  // ── MAC-05: Article or BlogPosting schema ────────────────────────────────
  {
    const hasSchemaInBody =
      /"@type"\s*:\s*"(Article|BlogPosting)"/i.test(schemaSource);
    const hasStoredSchema = !!schemaJson && typeof schemaJson === 'object' &&
      (JSON.stringify(schemaJson).includes('"Article"') || JSON.stringify(schemaJson).includes('"BlogPosting"'));
    const passed = hasSchemaInBody || hasStoredSchema;
    results.push(makeCheck('MAC-05',
      passed,
      passed ? 'Article/BlogPosting schema detected.' : 'No Article or BlogPosting JSON-LD schema found.'
    ));
  }

  // ── MAC-06: FAQPage schema ───────────────────────────────────────────────
  {
    const hasInBody = /"@type"\s*:\s*"FAQPage"/i.test(schemaSource);
    const hasStored = !!schemaJson && JSON.stringify(schemaJson).includes('"FAQPage"');
    const passed = hasInBody || hasStored;
    results.push(makeCheck('MAC-06',
      passed,
      passed ? 'FAQPage schema detected.' : 'No FAQPage schema found.'
    ));
  }

  // ── MAC-07: Organization schema ──────────────────────────────────────────
  {
    const hasInBody = /"@type"\s*:\s*"Organization"/i.test(schemaSource);
    const hasStored = !!schemaJson && JSON.stringify(schemaJson).includes('"Organization"');
    const passed = hasInBody || hasStored;
    results.push(makeCheck('MAC-07',
      passed,
      passed ? 'Organization schema detected.' : 'No Organization schema found.'
    ));
  }

  // ── MAC-08: Author / Person schema ───────────────────────────────────────
  {
    const hasInBody = /"@type"\s*:\s*"Person"/i.test(schemaSource) || /"@type"\s*:\s*"Author"/i.test(schemaSource);
    const hasStored = !!schemaJson && (JSON.stringify(schemaJson).includes('"Person"') || JSON.stringify(schemaJson).includes('"Author"'));
    const passed = hasInBody || hasStored;
    results.push(makeCheck('MAC-08',
      passed,
      passed ? 'Author/Person schema detected.' : 'No Author or Person schema found.'
    ));
  }

  // ── MAC-09: Internal link with anchor containing hubKeyword ──────────────
  {
    if (!hubKeyword) {
      results.push(makeCheck('MAC-09', null, 'N/A — no hubKeyword provided.'));
    } else if (!siteUrl) {
      results.push(makeCheck('MAC-09', false, 'URL not available — unable to check internal links.'));
    } else {
      const internalLinks = extractInternalLinks(bodyHtml, siteUrl, url);
      const pillarLink = internalLinks.find(l => containsKeyword(l.anchor, hubKeyword));
      results.push(makeCheck('MAC-09',
        !!pillarLink,
        pillarLink
          ? `Internal pillar link found: "${pillarLink.anchor}" → ${pillarLink.href}`
          : `No internal link with anchor text containing "${hubKeyword}" found.`
      ));
    }
  }

  // ── MAC-10: Internal link DOWN to child page (hub/pillar only) ───────────
  {
    if (!isHub) {
      results.push(makeCheck('MAC-10', null, 'N/A — not a hub/pillar page.'));
    } else if (!siteUrl) {
      results.push(makeCheck('MAC-10', false, 'URL not available — unable to check internal links.'));
    } else {
      const internalLinks = extractInternalLinks(bodyHtml, siteUrl, url);
      // A "child" link goes to a deeper path (URL has more segments than current)
      const currentPath = url ? (() => { try { return new URL(url).pathname; } catch { return ''; } })() : '';
      const childLink = internalLinks.find(l => l.path.startsWith(currentPath.replace(/\/$/, '') + '/') || l.path.length > currentPath.length);
      results.push(makeCheck('MAC-10',
        !!childLink,
        childLink
          ? `Internal child link found: "${childLink.anchor}" → ${childLink.href}`
          : 'No internal link to a child page found.'
      ));
    }
  }

  // ── MAC-11: At least one internal link to sibling post ───────────────────
  {
    if (!siteUrl) {
      results.push(makeCheck('MAC-11', false, 'URL not available — unable to check internal links.'));
    } else {
      const internalLinks = extractInternalLinks(bodyHtml, siteUrl, url);
      results.push(makeCheck('MAC-11',
        internalLinks.length > 0,
        internalLinks.length > 0
          ? `${internalLinks.length} internal link(s) found.`
          : 'No internal links to other pages on the same domain found.'
      ));
    }
  }

  // ── MAC-12: Core Web Vitals pass (live check) ────────────────────────────
  {
    if (!liveChecks || liveChecks.coreWebVitalsPass === undefined) {
      results.push(makeCheck('MAC-12', null, 'N/A — live check data not provided.'));
    } else {
      results.push(makeCheck('MAC-12',
        liveChecks.coreWebVitalsPass,
        liveChecks.coreWebVitalsPass ? 'Core Web Vitals pass.' : 'Core Web Vitals do not pass.'
      ));
    }
  }

  // ── MAC-13: llms.txt present (live check) ────────────────────────────────
  {
    if (!liveChecks || liveChecks.llmsTxtPresent === undefined) {
      results.push(makeCheck('MAC-13', null, 'N/A — live check data not provided.'));
    } else {
      results.push(makeCheck('MAC-13',
        liveChecks.llmsTxtPresent,
        liveChecks.llmsTxtPresent ? 'llms.txt file detected.' : 'No llms.txt file detected.'
      ));
    }
  }

  // ── MIC-01: Exactly one H1 ───────────────────────────────────────────────
  {
    const h1s = extractHeadings(bodyHtml, 1);
    results.push(makeCheck('MIC-01',
      h1s.length === 1,
      h1s.length === 0
        ? 'No H1 heading found.'
        : h1s.length === 1
          ? 'Exactly one H1 heading found.'
          : `${h1s.length} H1 headings found — should be exactly one.`
    ));
  }

  // ── MIC-02: Focus keyword in H1 ──────────────────────────────────────────
  {
    if (!focusKeyword) {
      results.push(makeCheck('MIC-02', false, 'No focus keyword set.'));
    } else {
      const h1s = extractHeadings(bodyHtml, 1);
      const passed = h1s.some(h => containsKeyword(h, focusKeyword));
      results.push(makeCheck('MIC-02',
        passed,
        passed ? 'Focus keyword found in H1.' : 'Focus keyword not found in H1.'
      ));
    }
  }

  // ── MIC-03: ≥ 50% of H2s are questions ──────────────────────────────────
  {
    const h2s = extractHeadings(bodyHtml, 2);
    if (h2s.length === 0) {
      results.push(makeCheck('MIC-03', false, 'No H2 headings found.'));
    } else {
      const questionH2s = h2s.filter(h => h.trim().endsWith('?') || QUESTION_STARTERS.test(h.trim()));
      const ratio = questionH2s.length / h2s.length;
      results.push(makeCheck('MIC-03',
        ratio >= 0.5,
        `${questionH2s.length} of ${h2s.length} H2s are questions (${Math.round(ratio * 100)}% — need ≥ 50%).`
      ));
    }
  }

  // ── MIC-04: At least one H3 ──────────────────────────────────────────────
  {
    const h3s = extractHeadings(bodyHtml, 3);
    results.push(makeCheck('MIC-04',
      h3s.length > 0,
      h3s.length > 0 ? `${h3s.length} H3 heading(s) found.` : 'No H3 headings found.'
    ));
  }

  // ── MIC-05: First paragraph after each H2 is ≤ 60 words ─────────────────
  {
    const h2Regex = /<h2[^>]*>.*?<\/h2>/gi;
    const h2Matches = Array.from(bodyHtml.matchAll(/<h2[^>]*>.*?<\/h2>/gi));
    if (h2Matches.length === 0) {
      results.push(makeCheck('MIC-05', false, 'No H2 headings found.'));
    } else {
      let allPass = true;
      let failDetail = '';
      for (const h2Match of h2Matches) {
        const afterH2 = bodyHtml.slice((h2Match.index ?? 0) + h2Match[0].length);
        const firstPMatch = afterH2.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        if (firstPMatch) {
          const text = stripHtml(firstPMatch[1]);
          const wc = wordCount(text);
          if (wc > 60) {
            allPass = false;
            failDetail = `Found paragraph with ${wc} words after an H2 (limit: 60).`;
            break;
          }
        }
      }
      results.push(makeCheck('MIC-05',
        allPass,
        allPass ? 'All first paragraphs after H2s are ≤ 60 words.' : failDetail
      ));
    }
  }

  // ── MIC-06: At least one ul or ol ────────────────────────────────────────
  {
    const hasUl = /<ul[^>]*>/i.test(bodyHtml);
    const hasOl = /<ol[^>]*>/i.test(bodyHtml);
    results.push(makeCheck('MIC-06',
      hasUl || hasOl,
      hasUl || hasOl ? 'List element found.' : 'No <ul> or <ol> list found.'
    ));
  }

  // ── MIC-07: Comparison data (table or bold-label list) ───────────────────
  {
    const hasTable = /<table[^>]*>/i.test(bodyHtml);
    // Bold-label list: li that starts with <strong> or <b>
    const hasBoldLabel = /<li[^>]*>\s*<(?:strong|b)[^>]*>/i.test(bodyHtml);
    results.push(makeCheck('MIC-07',
      hasTable || hasBoldLabel,
      hasTable ? 'Table element found.' :
      hasBoldLabel ? 'Bold-label list items found.' :
      'No comparison data element (table or bold-label list) found.'
    ));
  }

  // ── MIC-08: No paragraph longer than ~100 words ──────────────────────────
  {
    const paraRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m: RegExpExecArray | null;
    let maxWc = 0;
    while ((m = paraRegex.exec(bodyHtml)) !== null) {
      const text = stripHtml(m[1]);
      const wc = wordCount(text);
      if (wc > maxWc) maxWc = wc;
    }
    results.push(makeCheck('MIC-08',
      maxWc <= 100,
      maxWc === 0
        ? 'No paragraphs found.'
        : maxWc <= 100
          ? `Longest paragraph is ${maxWc} words — within limit.`
          : `Paragraph found with ${maxWc} words — exceeds 100-word limit.`
    ));
  }

  // ── EAT-05: Outbound link to .gov or .edu ───────────────────────────────
  {
    const extLinkRe = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    let hasGovEdu = false;
    while ((m = extLinkRe.exec(bodyHtml)) !== null) {
      const href = m[1];
      try {
        const hostname = new URL(href).hostname;
        if (hostname.endsWith('.gov') || hostname.endsWith('.gov.au') ||
            hostname.endsWith('.edu') || hostname.endsWith('.edu.au') ||
            hostname.includes('.gov.') || hostname.includes('.edu.')) {
          hasGovEdu = true;
          break;
        }
      } catch { /* ignore */ }
    }
    results.push(makeCheck('EAT-05',
      hasGovEdu,
      hasGovEdu ? 'Outbound link to a .gov or .edu domain found.' : 'No outbound link to a .gov or .edu domain found.'
    ));
  }

  // ── EAT-06: At least TWO unique external domains ────────────────────────
  {
    const extDomains = new Set<string>();
    const extLinkRe2 = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    let m2: RegExpExecArray | null;
    const siteDomain = siteUrl ? (() => { try { return new URL(siteUrl).hostname; } catch { return ''; } })() : '';
    while ((m2 = extLinkRe2.exec(bodyHtml)) !== null) {
      const href = m2[1];
      try {
        const hostname = new URL(href).hostname;
        if (siteDomain && (hostname === siteDomain || hostname.endsWith('.' + siteDomain))) continue;
        extDomains.add(hostname);
      } catch { /* ignore */ }
    }
    results.push(makeCheck('EAT-06',
      extDomains.size >= 2,
      extDomains.size >= 2
        ? `${extDomains.size} unique external domains linked.`
        : `Only ${extDomains.size} unique external domain(s) linked — need at least 2.`
    ));
  }

  // ── EAT-08: No AI buzzwords ──────────────────────────────────────────────
  {
    const bodyLower = bodyText.toLowerCase();
    const foundBuzzword = AI_BUZZWORDS.find(word => {
      const re = new RegExp(`\\b${word.replace(/-/g, '[\\s-]')}\\b`, 'i');
      return re.test(bodyLower);
    });
    results.push(makeCheck('EAT-08',
      !foundBuzzword,
      foundBuzzword
        ? `AI buzzword detected: "${foundBuzzword}". Remove or replace it.`
        : 'No AI buzzwords detected.'
    ));
  }

  return results;
}

// ---------------------------------------------------------------------------
// LLM-based checks (EAT-01 through EAT-04, EAT-07)
// ---------------------------------------------------------------------------

interface LlmEatResult {
  EAT01: { passed: boolean; detail: string };
  EAT02: { passed: boolean; detail: string };
  EAT03: { passed: boolean; detail: string };
  EAT04: { passed: boolean; detail: string };
  EAT07: { passed: boolean; detail: string };
}

async function runLlmEatChecks(bodyHtml: string): Promise<LlmEatResult | null> {
  const bodyText = stripHtml(bodyHtml);
  // First 4000 words
  const articleText = bodyText.split(/\s+/).slice(0, 4000).join(' ');

  const systemPrompt = 'You are an expert content analyst. Return only valid JSON.';
  const userPrompt = `Analyse this article excerpt and assess the following 5 checks. Return a JSON object with keys EAT01, EAT02, EAT03, EAT04, EAT07.

ARTICLE TEXT (first 4000 words):
${articleText}

Assess these checks:
EAT01: Does the article contain concrete stats, numbers, percentages, or case study data (not vague claims like "many studies show")?
EAT02: Does the article use first-hand experience phrasing ("I found", "we tried", "in my experience", "when I", "our team")?
EAT03: Does the article acknowledge a failed approach, mistake, or thing that didn't work?
EAT04: Is there an attributed expert blockquote (a <blockquote> with attribution, or text like "according to [Name]" with a specific person or org named)?
EAT07: Is the article written in majority active voice (most sentences have subject doing the action, not passive constructions)?

Return exactly:
{
  "EAT01": { "passed": true/false, "detail": "brief explanation" },
  "EAT02": { "passed": true/false, "detail": "brief explanation" },
  "EAT03": { "passed": true/false, "detail": "brief explanation" },
  "EAT04": { "passed": true/false, "detail": "brief explanation" },
  "EAT07": { "passed": true/false, "detail": "brief explanation" }
}`;

  try {
    const response = await invokeClaude({
      system: systemPrompt,
      messages: [{ role: 'user' as const, content: userPrompt }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'eat_checks',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              EAT01: { type: 'object', properties: { passed: { type: 'boolean' }, detail: { type: 'string' } }, required: ['passed', 'detail'], additionalProperties: false },
              EAT02: { type: 'object', properties: { passed: { type: 'boolean' }, detail: { type: 'string' } }, required: ['passed', 'detail'], additionalProperties: false },
              EAT03: { type: 'object', properties: { passed: { type: 'boolean' }, detail: { type: 'string' } }, required: ['passed', 'detail'], additionalProperties: false },
              EAT04: { type: 'object', properties: { passed: { type: 'boolean' }, detail: { type: 'string' } }, required: ['passed', 'detail'], additionalProperties: false },
              EAT07: { type: 'object', properties: { passed: { type: 'boolean' }, detail: { type: 'string' } }, required: ['passed', 'detail'], additionalProperties: false },
            },
            required: ['EAT01', 'EAT02', 'EAT03', 'EAT04', 'EAT07'],
            additionalProperties: false,
          },
        },
      },
    });
    const rawContent = response.choices?.[0]?.message?.content;
    if (!rawContent) return null;
    const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent);
    return JSON.parse(content) as LlmEatResult;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convert checks to backward-compat AuditPoint[]
// ---------------------------------------------------------------------------

function checksToPoints(checks: AuditCheck[]): AuditPoint[] {
  return checks.map(c => ({
    point: c.id,
    name: c.parameter,
    status: c.passed === true ? 'pass' : c.passed === false ? 'fail' : 'na',
    note: c.detail,
  }));
}

// ---------------------------------------------------------------------------
// runMechanicalChecks — MAC + MIC checks only, no LLM (backward compat)
// ---------------------------------------------------------------------------

export function runMechanicalChecks(input: PostAuditInput): AuditPoint[] {
  const mechanicalChecks = runMechanicalCheckItems(input);
  return checksToPoints(mechanicalChecks);
}

// ---------------------------------------------------------------------------
// runFullAudit — full 29-check audit with LLM
// ---------------------------------------------------------------------------

export async function runFullAudit(input: PostAuditInput): Promise<AuditResult> {
  // Run mechanical checks (MAC + MIC + mechanical EAT)
  const mechanicalChecks = runMechanicalCheckItems(input);

  // Run LLM EAT checks
  const llmResult = await runLlmEatChecks(input.bodyHtml);

  // Build EAT-01 through EAT-04 and EAT-07 checks
  const eatLlmChecks: AuditCheck[] = [];
  const llmIds: Array<[string, keyof LlmEatResult]> = [
    ['EAT-01', 'EAT01'], ['EAT-02', 'EAT02'], ['EAT-03', 'EAT03'],
    ['EAT-04', 'EAT04'], ['EAT-07', 'EAT07'],
  ];

  for (const [checkId, llmKey] of llmIds) {
    if (llmResult) {
      const r = llmResult[llmKey];
      eatLlmChecks.push(makeCheck(checkId, r.passed, r.detail));
    } else {
      // LLM failed — mark as unable_to_score in the points compat layer
      const def = CHECK_DEF_MAP.get(checkId)!;
      eatLlmChecks.push({
        id: checkId,
        parameter: def.parameter,
        phase: 'eat',
        passed: false, // treat as fail for scoring
        points: 0,
        maxPoints: def.maxPoints,
        detail: 'AI scoring unavailable. Re-run the audit to score this check.',
      });
    }
  }

  // Combine all checks in order
  const allChecks: AuditCheck[] = [...mechanicalChecks, ...eatLlmChecks];
  // Sort by CHECK_DEFS order
  const checkOrder = new Map(CHECK_DEFS.map((d, i) => [d.id, i]));
  allChecks.sort((a, b) => (checkOrder.get(a.id) ?? 99) - (checkOrder.get(b.id) ?? 99));

  // Compute scoring
  const applicableChecks = allChecks.filter(c => c.passed !== null);
  const total_score = applicableChecks.reduce((sum, c) => sum + c.points, 0);
  const applicable_max = applicableChecks.reduce((sum, c) => sum + c.maxPoints, 0);
  const normalized_score = applicable_max > 0 ? Math.round(total_score / applicable_max * 100) : 0;

  const grade = scoreToGrade(normalized_score);
  const failed_checks = allChecks
    .filter(c => c.passed === false)
    .map(c => ({ id: c.id, parameter: c.parameter }));

  // Backward compat points — if LLM failed, mark those as unable_to_score
  const points: AuditPoint[] = allChecks.map(c => {
    const isLlmCheck = llmIds.some(([id]) => id === c.id);
    if (isLlmCheck && !llmResult) {
      return { point: c.id, name: c.parameter, status: 'unable_to_score' as AuditPointStatus, note: c.detail };
    }
    return {
      point: c.id,
      name: c.parameter,
      status: c.passed === true ? 'pass' : c.passed === false ? 'fail' : 'na',
      note: c.detail,
    };
  });

  return {
    normalized_score,
    total_score,
    applicable_max,
    checks: allChecks,
    failed_checks,
    score: normalized_score,
    grade,
    points,
    potentialScore: applicable_max,
  };
}
