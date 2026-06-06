/**
 * public-audit.service.ts — Layer 10 Stage 1 service.
 *
 * Scrapes an arbitrary public blog post URL (Puppeteer for JS-rendered pages,
 * plain HTTP fast-path first) and runs the full 16-point audit engine.
 *
 * Key differences from the internal scraper (scrape.service.ts):
 *  - Targets a SINGLE blog post URL, not a multi-page business website
 *  - Extracts article-specific fields: title, body HTML, meta title, meta
 *    description, focus keyword (best-effort from meta tags / OG), and URL
 *  - Returns a PostAuditInput-compatible payload plus the raw HTML for rewrite
 */

import puppeteerCore from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { runFullAudit } from "./audit.service";
import type { AuditResult, PostAuditInput } from "./audit.service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRAPE_TIMEOUT_MS = 15_000;
const PUPPETEER_TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; iAuditBot/1.0; +https://iaudit.app/bot)";

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
  focusKeyword: string | null; // Best-effort from meta/OG tags
  pageSource: string;      // Full raw HTML (for P13 schema check)
}

export interface PublicAuditResult {
  scrape: PublicScrapeResult;
  audit: AuditResult;
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
 * Extract the main article body from HTML.
 * Priority: <article>, then <main>, then the largest <div> with substantial text.
 * Returns the raw inner HTML of the best candidate.
 */
function extractArticleHtml(html: string): string {
  // Try <article> first
  const articleMatch = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (articleMatch) return articleMatch[1];

  // Try <main>
  const mainMatch = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (mainMatch) return mainMatch[1];

  // Fallback: strip nav/header/footer/sidebar noise and return body
  return html
    .replace(/<(nav|header|footer|aside|script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+class=["'][^"']*(?:sidebar|widget|menu|nav|footer|header)[^"']*["'][^>]*>[\s\S]*?<\/[a-z]+>/gi, "");
}

/** Strip HTML tags to plain text */
function htmlToText(html: string): string {
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
      },
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

/** Puppeteer fallback for JS-rendered pages — returns full HTML or null */
async function fetchHtmlWithPuppeteer(url: string): Promise<string | null> {
  let browser: any = null;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteerCore.launch({
      args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1280, height: 800 },
      executablePath,
      headless: true,
    });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    // Use domcontentloaded instead of networkidle2 — much faster for most pages
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PUPPETEER_TIMEOUT_MS,
    });
    // Give JS a brief moment to render content
    await new Promise((r) => setTimeout(r, 2000));
    return await page.content();
  } catch {
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
 * Uses plain HTTP first; falls back to Puppeteer for JS-rendered pages.
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
  let html = await fetchHtml(url);

  // If blank or very short (< 500 chars of text), try Puppeteer as fallback
  // But only if the plain fetch didn't return a meaningful page
  const plainTextLength = html ? htmlToText(html).length : 0;
  if (!html || plainTextLength < 500) {
    const puppeteerHtml = await fetchHtmlWithPuppeteer(url);
    if (puppeteerHtml && htmlToText(puppeteerHtml).length > plainTextLength) {
      html = puppeteerHtml;
    }
  }

  if (!html) {
    throw new Error(
      "Could not fetch this URL. Please check that the post is publicly accessible and try again."
    );
  }

  // Extract fields
  const title =
    extractMeta(html, "og:title") ??
    extractTitle(html) ??
    parsedUrl.pathname.split("/").filter(Boolean).pop()?.replace(/-/g, " ") ??
    "Untitled Post";

  const metaTitle =
    extractMeta(html, "title") ??
    extractTitle(html);

  const metaDescription =
    extractMeta(html, "description") ??
    extractMeta(html, "og:description");

  // Focus keyword: try Yoast/RankMath meta tags first
  const focusKeyword =
    extractMeta(html, "article:tag") ??
    extractMeta(html, "keywords") ??
    null;

  const bodyHtml = extractArticleHtml(html);
  const bodyText = htmlToText(bodyHtml);

  // If body text is still very short, the page may be behind a paywall or login
  if (bodyText.length < 100) {
    throw new Error(
      "This page appears to require a login or has very little content. Please use a publicly accessible blog post URL."
    );
  }

  return {
    url,
    title,
    bodyHtml,
    bodyText,
    metaTitle,
    metaDescription,
    focusKeyword,
    pageSource: html,
  };
}

// ---------------------------------------------------------------------------
// Audit a scraped public post
// ---------------------------------------------------------------------------

/**
 * Scrape a public blog post URL and run the full 16-point audit engine.
 * focusKeyword is required for P1–P6; if not found in meta tags, the caller
 * must supply it (the frontend prompts the user if null is returned).
 */
export async function auditPublicPost(
  url: string,
  focusKeyword?: string
): Promise<PublicAuditResult> {
  const scrape = await scrapePublicPost(url);

  // Use provided keyword, or fall back to scraped meta keyword
  const keyword = focusKeyword ?? scrape.focusKeyword ?? "";

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
