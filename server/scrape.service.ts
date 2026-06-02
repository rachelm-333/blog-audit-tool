/**
 * iAudit Scrape Service — Stage 1 Business Profile Scraper
 *
 * Implements Section 7 of the scope:
 * - Fetches homepage, about, services, contact (max 10 pages, 30s timeout)
 * - Handles all 5 failure states from Table 9:
 *   1. 404 / unreachable
 *   2. JS-rendered blank page (Puppeteer fallback)
 *   3. 30-second timeout (partial data with flags)
 *   4. Non-English content (AI translates to English)
 *   5. Robots.txt blocks scraping (manual fill prompt)
 * - AI brand voice inference (Table 26)
 */

import puppeteerCore from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import robotsParser from "robots-parser";
import { invokeLLM } from "./_core/llm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScrapeFailureReason =
  | "unreachable"          // 404 or DNS failure
  | "robots_blocked"       // robots.txt disallows scraping
  | "timeout"              // 30s timeout — partial data returned
  | "js_rendered_blank"    // JS-rendered, Puppeteer fallback also blank
  | "non_english"          // Non-English site — AI translated
  | null;                  // Success

export type ScrapedField = {
  value: string | null;
  source: "scraped" | "ai_inferred" | "empty";
  needsReview?: boolean;   // true when AI translated or partial
};

export type ScrapeResult = {
  success: boolean;
  failureReason: ScrapeFailureReason;
  failureMessage: string | null;
  // Extracted fields
  businessName: ScrapedField;
  industry: ScrapedField;
  location: ScrapedField;
  services: ScrapedField;          // JSON string of {name, description}[]
  uvp: ScrapedField;
  brandVoice: ScrapedField;
  tone: ScrapedField;
  targetAudience: ScrapedField;
  languageStyle: ScrapedField;
  primaryCtaUrl: ScrapedField;
  primaryCtaLabel: ScrapedField;
  yearsInBusiness: ScrapedField;
  clientsServed: ScrapedField;
  awardsCredentials: ScrapedField;
  // Raw scraped text for debugging
  rawText: string;
  pagesScraped: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRAPE_TIMEOUT_MS = 30_000;
const MAX_PAGES = 10;
const USER_AGENT =
  "Mozilla/5.0 (compatible; iAuditBot/1.0; +https://iaudit.app/bot)";

// Page path patterns to look for (in priority order)
const PAGE_PATTERNS = {
  about: ["/about", "/about-us", "/our-story", "/who-we-are", "/company"],
  services: [
    "/services",
    "/products",
    "/what-we-do",
    "/solutions",
    "/offerings",
    "/our-services",
  ],
  contact: ["/contact", "/contact-us", "/get-in-touch", "/reach-us"],
};

// ---------------------------------------------------------------------------
// Robots.txt check
// ---------------------------------------------------------------------------

async function checkRobotsTxt(baseUrl: string): Promise<boolean> {
  try {
    const robotsUrl = new URL("/robots.txt", baseUrl).href;
    const resp = await fetch(robotsUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": USER_AGENT },
    });
    if (!resp.ok) return true; // No robots.txt = allowed
    const text = await resp.text();
    const robots = robotsParser(robotsUrl, text);
    // Check if our bot or all bots are allowed on the homepage
    const allowed =
      robots.isAllowed(baseUrl, "iAuditBot") !== false &&
      robots.isAllowed(baseUrl, "*") !== false;
    return allowed;
  } catch {
    return true; // Error reading robots.txt = proceed
  }
}

// ---------------------------------------------------------------------------
// Plain HTTP fetch (fast path)
// ---------------------------------------------------------------------------

async function fetchPageText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return extractTextFromHtml(html);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Puppeteer headless fetch (JS-rendered fallback)
// ---------------------------------------------------------------------------

async function fetchWithPuppeteer(url: string, timeoutMs: number): Promise<string | null> {
  let browser: any = null;
  try {
    const executablePath = await chromium.executablePath();
    browser = await puppeteerCore.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 800 },
      executablePath,
      headless: true,
    });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: timeoutMs,
    });
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return text.trim() || null;
  } catch {
    return null;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// HTML → plain text extractor
// ---------------------------------------------------------------------------

function extractTextFromHtml(html: string): string {
  // Remove scripts, styles, nav, footer, header noise
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
  // Limit to 8000 chars per page to avoid token overflow
  return cleaned.slice(0, 8000);
}

// ---------------------------------------------------------------------------
// Extract CTAs from HTML
// ---------------------------------------------------------------------------

function extractCtas(html: string, baseUrl: string): { url: string; label: string }[] {
  const ctas: { url: string; label: string }[] = [];
  const ctaPatterns =
    /href=["']([^"']+)["'][^>]*>([^<]{2,40})<\/a/gi;
  const ctaKeywords =
    /book|contact|call|get.?started|free|quote|consult|shop|buy|order|enquir|appointment|schedule|reserve/i;
  let match;
  while ((match = ctaPatterns.exec(html)) !== null && ctas.length < 4) {
    const [, href, label] = match;
    if (ctaKeywords.test(label)) {
      try {
        const full = new URL(href, baseUrl).href;
        if (!ctas.find((c) => c.url === full)) {
          ctas.push({ url: full, label: label.trim() });
        }
      } catch { /* invalid URL */ }
    }
  }
  return ctas;
}

// ---------------------------------------------------------------------------
// Detect if content is non-English
// ---------------------------------------------------------------------------

function isLikelyNonEnglish(text: string): boolean {
  // Simple heuristic: check for common non-ASCII character density
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  const ratio = nonAscii / Math.max(text.length, 1);
  return ratio > 0.15;
}

// ---------------------------------------------------------------------------
// AI inference — brand voice + all fields from scraped text
// ---------------------------------------------------------------------------

export async function inferBusinessProfile(
  rawText: string,
  websiteUrl: string
): Promise<{
  businessName: string | null;
  industry: string | null;
  location: string | null;
  services: string | null;
  uvp: string | null;
  brandVoice: string | null;
  tone: string | null;
  targetAudience: string | null;
  languageStyle: string | null;
  primaryCtaUrl: string | null;
  primaryCtaLabel: string | null;
  yearsInBusiness: string | null;
  clientsServed: string | null;
  awardsCredentials: string | null;
  isNonEnglish: boolean;
  translatedFrom: string | null;
}> {
  const prompt = `You are analysing website copy to extract a business profile for an SEO tool.

Website URL: ${websiteUrl}

Scraped website text:
---
${rawText.slice(0, 12000)}
---

Extract the following information from the website copy. If a field cannot be determined from the copy, return null for that field. Do NOT fabricate or assume any information.

Return a JSON object with these exact fields:
- businessName: string | null — The business name from page title, logo text, or header
- industry: string | null — The industry/niche in plain English (e.g. "Pool Installation", "Dental Practice")
- location: string | null — City and state/country (e.g. "Sydney, NSW")
- services: array | null — Array of {name: string, description: string} objects for each service/product offered (max 8)
- uvp: string | null — The unique value proposition from the hero section or about page (1-2 sentences)
- brandVoice: string | null — A 2-3 sentence paragraph describing the brand voice based on the tone and language used in the copy
- tone: string | null — One of: "Professional", "Friendly", "Bold", "Conversational"
- targetAudience: string | null — Who the business serves in plain English (e.g. "Sydney homeowners planning a renovation")
- languageStyle: string | null — Language style observed (e.g. "Australian English, plain language" or "Formal British English")
- primaryCtaUrl: string | null — The most prominent call-to-action URL (booking, contact, shop, etc.)
- primaryCtaLabel: string | null — The label text of the primary CTA button
- yearsInBusiness: string | null — Years in business if mentioned (e.g. "15")
- clientsServed: string | null — Number of clients/customers if mentioned (e.g. "800")
- awardsCredentials: string | null — Awards, certifications, or credentials mentioned
- isNonEnglish: boolean — true if the original copy was not in English
- translatedFrom: string | null — Language name if isNonEnglish is true (e.g. "French")`;

  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a precise data extraction assistant. Extract only what is explicitly present in the provided text. Never fabricate information. Return valid JSON only.",
        },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "business_profile",
          strict: true,
          schema: {
            type: "object",
            properties: {
              businessName: { type: ["string", "null"] },
              industry: { type: ["string", "null"] },
              location: { type: ["string", "null"] },
              services: {
                oneOf: [
                  {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        description: { type: "string" },
                      },
                      required: ["name", "description"],
                      additionalProperties: false,
                    },
                  },
                  { type: "null" },
                ],
              },
              uvp: { type: ["string", "null"] },
              brandVoice: { type: ["string", "null"] },
              tone: { type: ["string", "null"] },
              targetAudience: { type: ["string", "null"] },
              languageStyle: { type: ["string", "null"] },
              primaryCtaUrl: { type: ["string", "null"] },
              primaryCtaLabel: { type: ["string", "null"] },
              yearsInBusiness: { type: ["string", "null"] },
              clientsServed: { type: ["string", "null"] },
              awardsCredentials: { type: ["string", "null"] },
              isNonEnglish: { type: "boolean" },
              translatedFrom: { type: ["string", "null"] },
            },
            required: [
              "businessName",
              "industry",
              "location",
              "services",
              "uvp",
              "brandVoice",
              "tone",
              "targetAudience",
              "languageStyle",
              "primaryCtaUrl",
              "primaryCtaLabel",
              "yearsInBusiness",
              "clientsServed",
              "awardsCredentials",
              "isNonEnglish",
              "translatedFrom",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    // Serialise services array to JSON string for storage
    if (parsed.services && Array.isArray(parsed.services)) {
      parsed.services = JSON.stringify(parsed.services);
    }
    return parsed;
  } catch (err) {
    console.error("[Scrape] AI inference failed:", err);
    // Return all nulls — user fills manually
    return {
      businessName: null,
      industry: null,
      location: null,
      services: null,
      uvp: null,
      brandVoice: null,
      tone: null,
      targetAudience: null,
      languageStyle: null,
      primaryCtaUrl: null,
      primaryCtaLabel: null,
      yearsInBusiness: null,
      clientsServed: null,
      awardsCredentials: null,
      isNonEnglish: false,
      translatedFrom: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Helper: make a ScrapedField
// ---------------------------------------------------------------------------

function field(
  value: string | null,
  source: ScrapedField["source"] = "scraped",
  needsReview = false
): ScrapedField {
  return { value, source, needsReview };
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

export async function scrapeBusinessWebsite(websiteUrl: string): Promise<ScrapeResult> {
  const emptyResult = (): ScrapeResult => ({
    success: false,
    failureReason: null,
    failureMessage: null,
    businessName: field(null, "empty"),
    industry: field(null, "empty"),
    location: field(null, "empty"),
    services: field(null, "empty"),
    uvp: field(null, "empty"),
    brandVoice: field(null, "empty"),
    tone: field(null, "empty"),
    targetAudience: field(null, "empty"),
    languageStyle: field(null, "empty"),
    primaryCtaUrl: field(null, "empty"),
    primaryCtaLabel: field(null, "empty"),
    yearsInBusiness: field(null, "empty"),
    clientsServed: field(null, "empty"),
    awardsCredentials: field(null, "empty"),
    rawText: "",
    pagesScraped: [],
  });

  // Normalise URL
  let baseUrl: string;
  try {
    const u = new URL(
      websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`
    );
    baseUrl = u.origin;
  } catch {
    return {
      ...emptyResult(),
      failureReason: "unreachable",
      failureMessage:
        "We could not reach that website. Please check the URL and try again.",
    };
  }

  // ── Failure State 1: robots.txt check ──────────────────────────────────
  const robotsAllowed = await checkRobotsTxt(baseUrl);
  if (!robotsAllowed) {
    return {
      ...emptyResult(),
      failureReason: "robots_blocked",
      failureMessage:
        "This website's robots.txt does not allow automated access. Please fill in your business profile manually.",
    };
  }

  // ── Collect pages ──────────────────────────────────────────────────────
  const startTime = Date.now();
  const pagesScraped: string[] = [];
  const allText: string[] = [];
  let timedOut = false;
  let homepageHtml = "";

  // Helper: fetch with remaining time budget
  const fetchWithBudget = async (url: string): Promise<string | null> => {
    const elapsed = Date.now() - startTime;
    const remaining = SCRAPE_TIMEOUT_MS - elapsed;
    if (remaining <= 0) { timedOut = true; return null; }
    return fetchPageText(url, Math.min(remaining, 8000));
  };

  // 1. Homepage (plain HTTP first)
  let homepageText: string | null = null;
  try {
    const homepageResp = await fetch(baseUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": USER_AGENT },
    });

    // ── Failure State 1: 404 / unreachable ──────────────────────────────
    if (!homepageResp.ok) {
      return {
        ...emptyResult(),
        failureReason: "unreachable",
        failureMessage:
          "We could not reach that website. Please check the URL and try again.",
      };
    }

    homepageHtml = await homepageResp.text();
    homepageText = extractTextFromHtml(homepageHtml);
  } catch {
    // ── Failure State 1: DNS / network failure ───────────────────────────
    return {
      ...emptyResult(),
      failureReason: "unreachable",
      failureMessage:
        "We could not reach that website. Please check the URL and try again.",
    };
  }

  // ── Failure State 2: JS-rendered blank page ──────────────────────────
  const isBlank = !homepageText || homepageText.trim().length < 100;
  if (isBlank) {
    const puppeteerText = await fetchWithPuppeteer(baseUrl, 15000);
    if (!puppeteerText || puppeteerText.trim().length < 100) {
      // Puppeteer also blank — ask user to fill manually
      return {
        ...emptyResult(),
        failureReason: "js_rendered_blank",
        failureMessage:
          "We could not read this website's content — it may require a login or use a technology we cannot access. Please fill in your business profile manually.",
      };
    }
    homepageText = puppeteerText;
  }

  pagesScraped.push(baseUrl);
  allText.push(homepageText);

  // 2. Try to find and fetch about, services, contact pages
  const pagesToTry: string[] = [];
  for (const [, patterns] of Object.entries(PAGE_PATTERNS)) {
    for (const pattern of patterns) {
      pagesToTry.push(new URL(pattern, baseUrl).href);
    }
  }

  let pageCount = 1;
  const tried = new Set<string>([baseUrl]);

  for (const pageUrl of pagesToTry) {
    if (pageCount >= MAX_PAGES) break;
    if (tried.has(pageUrl)) continue;
    tried.add(pageUrl);

    const elapsed = Date.now() - startTime;
    if (elapsed >= SCRAPE_TIMEOUT_MS) { timedOut = true; break; }

    const text = await fetchWithBudget(pageUrl);
    if (text && text.trim().length > 200) {
      pagesScraped.push(pageUrl);
      allText.push(text);
      pageCount++;
    }
  }

  // ── Failure State 3: Timeout — proceed with partial data ─────────────
  const rawText = allText.join("\n\n---\n\n");
  const isNonEnglish = isLikelyNonEnglish(rawText);

  // ── Failure State 4: Non-English — AI will translate ─────────────────
  // (handled inside inferBusinessProfile — AI translates field values)

  // Extract CTAs from homepage HTML
  const ctas = extractCtas(homepageHtml, baseUrl);

  // AI inference
  const ai = await inferBusinessProfile(rawText, baseUrl);

  // Build result
  const needsReview = timedOut || ai.isNonEnglish;

  const makeField = (
    aiValue: string | null,
    ctaFallback?: string | null
  ): ScrapedField => {
    const val = aiValue ?? ctaFallback ?? null;
    if (!val) return field(null, "empty");
    return field(val, ai.isNonEnglish ? "ai_inferred" : "scraped", needsReview);
  };

  // Primary CTA: prefer AI-extracted, fallback to HTML-extracted
  const primaryCta = ctas[0];
  const primaryCtaUrl = ai.primaryCtaUrl ?? primaryCta?.url ?? null;
  const primaryCtaLabel = ai.primaryCtaLabel ?? primaryCta?.label ?? null;

  const result: ScrapeResult = {
    success: !timedOut,
    failureReason: timedOut ? "timeout" : (ai.isNonEnglish ? "non_english" : null),
    failureMessage: timedOut
      ? "We could not read all pages within the time limit. Fields we could not read are flagged — please fill them in."
      : ai.isNonEnglish
      ? `This website appears to be in ${ai.translatedFrom ?? "a non-English language"}. Field values have been translated to English — please review and correct them.`
      : null,
    businessName: makeField(ai.businessName),
    industry: makeField(ai.industry),
    location: makeField(ai.location),
    services: makeField(ai.services),
    uvp: makeField(ai.uvp),
    brandVoice: makeField(ai.brandVoice),
    tone: makeField(ai.tone),
    targetAudience: makeField(ai.targetAudience),
    languageStyle: makeField(ai.languageStyle),
    primaryCtaUrl: makeField(primaryCtaUrl),
    primaryCtaLabel: makeField(primaryCtaLabel),
    yearsInBusiness: makeField(ai.yearsInBusiness),
    clientsServed: makeField(ai.clientsServed),
    awardsCredentials: makeField(ai.awardsCredentials),
    rawText,
    pagesScraped,
  };

  return result;
}
