/**
 * public-audit.service.ts — Layer 10 Stage 1 service.
 *
 * Scrapes an arbitrary public blog post URL (Puppeteer for JS-rendered pages,
 * plain HTTP fast-path first) and runs the full 16-point audit engine.
 *
 * Scraping strategy:
 *  1. Plain HTTP fetch (fast path) — works for server-rendered pages
 *  2. If content is thin (< 800 chars of text), Puppeteer with networkidle2
 *     wait + DOM-based extraction — required for Wix/Squarespace/React pages
 *  3. Keyword auto-extraction from page title when no meta keyword is found
 *
 * Wix-specific notes:
 *  - Wix pages are React SPAs — content is injected by JS after page load
 *  - The correct content selector is [data-hook="post-description"]
 *  - networkidle0 never triggers on Wix (persistent analytics calls)
 *  - networkidle2 works but may time out — we catch and use available content
 */

import puppeteerCore from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { runFullAudit } from "./audit.service";
import type { AuditResult, PostAuditInput } from "./audit.service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRAPE_TIMEOUT_MS = 15_000;
/** Puppeteer navigation timeout */
const PUPPETEER_NAV_TIMEOUT_MS = 30_000;
/** Extra settle time after navigation for JS-heavy pages like Wix */
const PUPPETEER_SETTLE_MS = 4_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublicScrapeResult {
  url: string;
  title: string;
  bodyHtml: string;        // Full article HTML (used for rewrite)
  bodyText: string;        // Plain text (for word-count / density checks)
  metaTitle: string | null;
  metaDescription: string | null;
  focusKeyword: string | null; // Best-effort from meta/OG tags or title extraction
  pageSource: string;      // Full raw HTML (for P13 schema check)
}

export interface PublicAuditResult {
  scrape: PublicScrapeResult;
  audit: AuditResult;
}

interface PuppeteerResult {
  pageHtml: string;
  articleHtml: string;
  title: string;
  h1: string;
  metaTitle: string;
  metaDesc: string;
  ogTitle: string;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** Extract the content of a <meta> tag by name or property */
function extractMeta(html: string, nameOrProp: string): string | null {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${nameOrProp}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${nameOrProp}["']`,
    "i"
  );
  return (re.exec(html) ?? re2.exec(html))?.[1]?.trim() ?? null;
}

/** Extract <title> tag content */
function extractTitle(html: string): string | null {
  return /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
}

/**
 * Extract the main article body from raw HTML (regex-based, for plain HTTP path).
 * Priority: [data-hook="post-description"] (Wix), <article>, <main>, then body.
 */
function extractArticleHtml(html: string): string {
  // Wix: [data-hook="post-description"]
  const wixPostDesc = /data-hook=["']post-description["'][^>]*>([\s\S]*?)<\/(?:div|section|article)>/i.exec(html);
  if (wixPostDesc && stripHtml(wixPostDesc[1]).length > 200) {
    return wixPostDesc[1];
  }

  // Try <article> first
  const articleMatch = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (articleMatch && stripHtml(articleMatch[1]).length > 200) {
    return articleMatch[1];
  }

  // Try <main>
  const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (mainMatch && stripHtml(mainMatch[1]).length > 200) {
    return mainMatch[1];
  }

  // Fallback: strip nav/header/footer/sidebar noise and return body
  return html
    .replace(/<(nav|header|footer|aside|script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+class=["'][^"']*(?:sidebar|widget|menu|nav|footer|header)[^"']*["'][^>]*>[\s\S]*?<\/[a-z]+>/gi, "");
}

/** Strip HTML tags to plain text */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Keyword auto-extraction from title
// ---------------------------------------------------------------------------

const TITLE_STOP_PHRASES = [
  /^(your\s+)?definitive\s+guide\s+to\s+/i,
  /^(a\s+)?complete\s+guide\s+to\s+/i,
  /^(a\s+)?beginner'?s?\s+guide\s+to\s+/i,
  /^how\s+to\s+/i,
  /^what\s+is\s+/i,
  /^what\s+are\s+/i,
  /^why\s+/i,
  /^when\s+/i,
  /^where\s+/i,
  /^who\s+/i,
  /^the\s+best\s+/i,
  /^top\s+\d+\s+/i,
  /^everything\s+you\s+need\s+to\s+know\s+about\s+/i,
  /^the\s+ultimate\s+guide\s+to\s+/i,
  /\s+in\s+\d{4}$/i,
  /\s*[-–—]\s+.*$/,
  /\s*[:|]\s+.*$/,
];

function extractKeywordFromTitle(title: string, bodyText?: string): string | null {
  if (!title || title.length < 3) return null;

  let cleaned = title;
  for (const pattern of TITLE_STOP_PHRASES) {
    cleaned = cleaned.replace(pattern, "").trim();
  }
  if (!cleaned || cleaned.length < 3) cleaned = title;

  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (words.length === 0) return null;
  if (words.length <= 3) return words.join(" ");

  const ngrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    ngrams.push(words.slice(i, i + 2).join(" "));
    if (i < words.length - 2) {
      ngrams.push(words.slice(i, i + 3).join(" "));
    }
  }

  const bodyLower = bodyText?.toLowerCase() ?? "";
  const scores: Record<string, number> = {};
  for (const ng of ngrams) {
    let score = 3;
    if (bodyLower && bodyLower.includes(ng)) score += 2;
    const titleLower = cleaned.toLowerCase();
    const pos = titleLower.indexOf(ng);
    if (pos !== -1 && pos < titleLower.length / 2) score += 1;
    scores[ng] = score;
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : words.slice(0, 3).join(" ");
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/** Fast-path plain HTTP fetch — returns full HTML or null */
async function fetchHtml(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-AU,en;q=0.9",
      },
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/**
 * Puppeteer fallback for JS-rendered pages (Wix, Squarespace, React SPAs).
 * Uses DOM-based extraction to get clean article content without JS noise.
 */
async function fetchWithPuppeteer(url: string): Promise<PuppeteerResult | null> {
  let browser: any = null;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteerCore.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
      defaultViewport: { width: 1280, height: 900 },
      executablePath,
      headless: true,
    });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    // Block images, fonts, and media to speed up rendering
    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      const type = req.resourceType();
      if (["image", "font", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate — use networkidle2 (≤2 pending requests) which works for Wix
    // Wix pages never reach networkidle0 due to persistent analytics calls
    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: PUPPETEER_NAV_TIMEOUT_MS,
      });
    } catch {
      // If networkidle2 times out, we still have domcontentloaded content
      console.log("[Puppeteer] networkidle2 timed out, using available content");
    }

    // Extra settle time for React/Wix hydration to complete
    await new Promise((r) => setTimeout(r, PUPPETEER_SETTLE_MS));

    // Use DOM-based extraction for clean content (avoids inline JS noise)
    const domResult = await page.evaluate((): {
      articleHtml: string;
      title: string;
      h1: string;
      metaTitle: string;
      metaDesc: string;
      ogTitle: string;
    } => {
      // Priority order for article content selectors
      const contentSelectors = [
        '[data-hook="post-description"]',  // Wix blog post content
        '[data-hook="post-content"]',
        'article',
        'main',
        '[class*="post-body"]',
        '[class*="article-body"]',
        '[class*="blog-post"]',
      ];

      let articleEl: Element | null = null;
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el && (el.textContent?.trim().length ?? 0) > 200) {
          articleEl = el;
          break;
        }
      }

      const articleHtml = articleEl ? articleEl.innerHTML : document.body.innerHTML;
      const title = document.title || "";
      const h1 = document.querySelector("h1")?.textContent?.trim() ?? "";
      const metaTitle = (document.querySelector('meta[name="title"]') as HTMLMetaElement | null)?.content
        ?? (document.querySelector("title") as HTMLTitleElement | null)?.textContent?.trim()
        ?? "";
      const metaDesc = (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content
        ?? (document.querySelector('meta[property="og:description"]') as HTMLMetaElement | null)?.content
        ?? "";
      const ogTitle = (document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null)?.content ?? "";

      return { articleHtml, title, h1, metaTitle, metaDesc, ogTitle };
    });

    const pageHtml = await page.content();

    return {
      pageHtml,
      articleHtml: domResult.articleHtml,
      title: domResult.title,
      h1: domResult.h1,
      metaTitle: domResult.metaTitle,
      metaDesc: domResult.metaDesc,
      ogTitle: domResult.ogTitle,
    };
  } catch (err) {
    console.error("[Puppeteer] Error:", err);
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

/**
 * Scrape a public blog post URL and extract all fields needed for a 16-point audit.
 *
 * Strategy:
 * 1. Plain HTTP fetch (fast, works for server-rendered pages)
 * 2. If text content < 800 chars, use Puppeteer (required for Wix/React pages)
 * 3. Auto-extract focus keyword from title + body if not in meta tags
 */
export async function scrapePublicPost(url: string): Promise<PublicScrapeResult> {
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Invalid URL — please enter a full URL including https://");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported");
  }

  // Try plain HTTP first (fast path)
  const plainHtml = await fetchHtml(url);
  const plainTextLength = plainHtml ? stripHtml(extractArticleHtml(plainHtml)).length : 0;
  const needsPuppeteer = !plainHtml || plainTextLength < 800;

  console.log(`[PublicAudit] Plain HTTP article text: ${plainTextLength} chars, needsPuppeteer: ${needsPuppeteer}`);

  let title: string;
  let metaTitle: string | null;
  let metaDescription: string | null;
  let bodyHtml: string;
  let pageSource: string;

  if (needsPuppeteer) {
    console.log(`[PublicAudit] Using Puppeteer for ${url}`);
    const puppResult = await fetchWithPuppeteer(url);

    if (puppResult && stripHtml(puppResult.articleHtml).length > 200) {
      // Use DOM-extracted content from Puppeteer
      title = puppResult.ogTitle || puppResult.h1 || puppResult.title || parsedUrl.pathname.split("/").filter(Boolean).pop()?.replace(/-/g, " ") || "Untitled Post";
      metaTitle = puppResult.metaTitle || puppResult.title || null;
      metaDescription = puppResult.metaDesc || null;
      bodyHtml = puppResult.articleHtml;
      pageSource = puppResult.pageHtml;
      console.log(`[PublicAudit] Puppeteer DOM extraction: ${stripHtml(bodyHtml).length} chars`);
    } else if (plainHtml) {
      // Fall back to plain HTML if Puppeteer failed
      console.log(`[PublicAudit] Puppeteer failed or thin content, falling back to plain HTML`);
      title = extractMeta(plainHtml, "og:title") ?? extractTitle(plainHtml) ?? parsedUrl.pathname.split("/").filter(Boolean).pop()?.replace(/-/g, " ") ?? "Untitled Post";
      metaTitle = extractMeta(plainHtml, "title") ?? extractTitle(plainHtml);
      metaDescription = extractMeta(plainHtml, "description") ?? extractMeta(plainHtml, "og:description");
      bodyHtml = extractArticleHtml(plainHtml);
      pageSource = plainHtml;
    } else {
      throw new Error("Could not fetch this URL. Please check that the post is publicly accessible and try again.");
    }
  } else {
    // Use plain HTML (fast path)
    console.log(`[PublicAudit] Using plain HTTP result`);
    title = extractMeta(plainHtml!, "og:title") ?? extractTitle(plainHtml!) ?? parsedUrl.pathname.split("/").filter(Boolean).pop()?.replace(/-/g, " ") ?? "Untitled Post";
    metaTitle = extractMeta(plainHtml!, "title") ?? extractTitle(plainHtml!);
    metaDescription = extractMeta(plainHtml!, "description") ?? extractMeta(plainHtml!, "og:description");
    bodyHtml = extractArticleHtml(plainHtml!);
    pageSource = plainHtml!;
  }

  const bodyText = stripHtml(bodyHtml);
  console.log(`[PublicAudit] Final body text length: ${bodyText.length} chars`);

  // If body text is still very short, the page may be behind a paywall or login
  if (bodyText.length < 100) {
    throw new Error(
      "This page appears to require a login or has very little content. Please use a publicly accessible blog post URL."
    );
  }

  // Focus keyword: try Yoast/RankMath/keywords meta tags first
  let focusKeyword =
    extractMeta(pageSource, "article:tag") ??
    extractMeta(pageSource, "keywords") ??
    null;

  // Auto-extract keyword from title + body if not found in meta tags
  if (!focusKeyword) {
    const titleForKw = metaTitle ?? title;
    focusKeyword = extractKeywordFromTitle(titleForKw, bodyText);
    console.log(`[PublicAudit] Auto-extracted keyword: "${focusKeyword}" from title: "${titleForKw}"`);
  }

  return {
    url,
    title,
    bodyHtml,
    bodyText,
    metaTitle,
    metaDescription,
    focusKeyword,
    pageSource,
  };
}

// ---------------------------------------------------------------------------
// Audit a scraped public post
// ---------------------------------------------------------------------------

/**
 * Scrape a public blog post URL and run the full 16-point audit engine.
 * If focusKeyword is provided by the user, it overrides the auto-extracted one.
 * If not provided, the keyword is auto-extracted from the page title.
 */
export async function auditPublicPost(
  url: string,
  focusKeyword?: string
): Promise<PublicAuditResult> {
  const scrape = await scrapePublicPost(url);

  // Use provided keyword (user override), or fall back to auto-extracted
  const keyword = focusKeyword?.trim() || scrape.focusKeyword || null;

  const auditInput: PostAuditInput = {
    title: scrape.title,
    bodyHtml: scrape.bodyHtml,
    url: scrape.url,
    focusKeyword: keyword,
    metaTitle: scrape.metaTitle,
    metaDescription: scrape.metaDescription,
    // No CTA URLs available for public audits (no business profile yet)
    primaryCtaUrl: null,
    secondaryCtaUrls: [],
  };

  const audit = await runFullAudit(auditInput);

  return { scrape, audit };
}
