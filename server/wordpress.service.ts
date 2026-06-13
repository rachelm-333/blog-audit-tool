/**
 * WordPress REST API import engine.
 *
 * Spec reference: Section 8.3 (What Is Imported) + Section 16.1 (WordPress REST API).
 *
 * Auth: Application Password — Base64(username:app_password) in Authorization header.
 * Endpoint: GET /wp-json/wp/v2/posts?status=publish,future,draft&per_page=100
 * Focus keyword: _yoast_wpseo_focuskw meta field (Yoast) or rank_math_focus_keyword (RankMath).
 *
 * Error states (Table 12):
 *   - invalid_credentials   → 401 from WP REST API
 *   - insufficient_permissions → 403 from WP REST API
 *   - site_unreachable       → network error / DNS failure / non-WP URL
 *   - rate_limit             → 429 from WP REST API
 *   - zero_posts             → empty array returned for the selected status filter
 */

import { JSDOM } from "jsdom";
import type { WordPressCredentials } from "./encryption.service";
import { validateKeyword } from "./keyword.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export type WpPostStatus = "published" | "scheduled" | "draft";

export interface WpImportedPost {
  cmsPostId: string;
  title: string;
  bodyHtml: string;
  url: string;
  status: WpPostStatus;
  publishDate: Date | null;
  scheduledDate: Date | null;
  authorIdCms: string;
  authorNameCms: string;
  focusKeyword: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  featuredImageUrl: string | null;
  featuredImageAlt: string | null;
  bodyImageAlts: string[];
  categories: string[];
  tags: string[];
}

export type WpImportError =
  | "invalid_credentials"
  | "insufficient_permissions"
  | "site_unreachable"
  | "rate_limit"
  | "zero_posts"
  | "not_wordpress";

export class WpImportException extends Error {
  constructor(
    public readonly code: WpImportError,
    message: string
  ) {
    super(message);
    this.name = "WpImportException";
  }
}

// ─── Status mapping ───────────────────────────────────────────────────────────
// WP REST API uses "publish" / "future" / "draft" — we map to our enum
const WP_STATUS_MAP: Record<string, WpPostStatus> = {
  publish: "published",
  future: "scheduled",
  draft: "draft",
};

// Filter → WP REST API status param
const STATUS_FILTER_MAP: Record<string, string> = {
  published: "publish",
  scheduled: "future",
  draft: "draft",
  all: "publish,future,draft",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAuthHeader(username: string, appPassword: string): string {
  const token = Buffer.from(`${username}:${appPassword}`).toString("base64");
  return `Basic ${token}`;
}

export function normaliseUrl(url: string): string {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return `https://${url}`;
  }
  return url.replace(/\/$/, "");
}

/** Extract all image alt texts from a post body HTML string. */
export function extractBodyImageAlts(html: string): string[] {
  try {
    const dom = new JSDOM(html);
    const imgs = dom.window.document.querySelectorAll("img");
    const alts: string[] = [];
    imgs.forEach((img: Element) => {
      const alt = img.getAttribute("alt");
      if (alt && alt.trim()) alts.push(alt.trim());
    });
    return alts;
  } catch {
    return [];
  }
}

// ─── Connection test ──────────────────────────────────────────────────────────

/**
 * Tests a WordPress connection by hitting the /wp-json/wp/v2/users/me endpoint.
 * Returns the authenticated user's display name on success.
 * Throws WpImportException on any failure.
 */
export async function testWordPressConnection(
  creds: WordPressCredentials
): Promise<{ displayName: string; userId: number }> {
  const baseUrl = normaliseUrl(creds.siteUrl);
  const authHeader = buildAuthHeader(creds.username, creds.applicationPassword);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/wp-json/wp/v2/users/me`, {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    // Network error, DNS failure, or non-WP site
    if (err?.name === "TimeoutError") {
      throw new WpImportException("site_unreachable", "Connection timed out. Please check the URL and try again.");
    }
    throw new WpImportException("site_unreachable", "Could not reach the website. Please check it is online and try again.");
  }

  if (res.status === 401) {
    throw new WpImportException("invalid_credentials", "We could not connect to your WordPress site. Please check your URL, username, and application password.");
  }
  if (res.status === 403) {
    throw new WpImportException("insufficient_permissions", "Your WordPress user does not have permission to read or edit posts. Please use an Administrator account.");
  }
  if (res.status === 404) {
    // /wp-json endpoint not found — not a WordPress site or REST API disabled
    throw new WpImportException("not_wordpress", "The URL does not appear to be a WordPress site, or the REST API is disabled.");
  }
  if (res.status === 429) {
    throw new WpImportException("rate_limit", "Import paused — too many requests. We will continue automatically in 60 seconds.");
  }
  if (!res.ok) {
    throw new WpImportException("site_unreachable", `Unexpected response from WordPress (HTTP ${res.status}). Please check the site is online.`);
  }

  const data = (await res.json()) as { name?: string; id?: number };
  return {
    displayName: data.name ?? creds.username,
    userId: data.id ?? 0,
  };
}

// ─── Author cache ─────────────────────────────────────────────────────────────

async function fetchAuthorName(
  baseUrl: string,
  authHeader: string,
  authorId: number,
  cache: Map<number, string>
): Promise<string> {
  if (cache.has(authorId)) return cache.get(authorId)!;
  try {
    const res = await fetch(`${baseUrl}/wp-json/wp/v2/users/${authorId}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { name?: string };
      const name = data.name ?? `Author ${authorId}`;
      cache.set(authorId, name);
      return name;
    }
  } catch {
    // Ignore — fall through to default
  }
  const fallback = `Author ${authorId}`;
  cache.set(authorId, fallback);
  return fallback;
}

// ─── Featured image ───────────────────────────────────────────────────────────

async function fetchFeaturedImage(
  baseUrl: string,
  authHeader: string,
  mediaId: number
): Promise<{ url: string | null; alt: string | null }> {
  try {
    const res = await fetch(`${baseUrl}/wp-json/wp/v2/media/${mediaId}`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        source_url?: string;
        alt_text?: string;
      };
      return {
        url: data.source_url ?? null,
        alt: data.alt_text ?? null,
      };
    }
  } catch {
    // Ignore
  }
  return { url: null, alt: null };
}

// ─── Category / tag names ─────────────────────────────────────────────────────

async function fetchTermNames(
  baseUrl: string,
  authHeader: string,
  taxonomy: "categories" | "tags",
  ids: number[]
): Promise<Array<{ id: number; name: string }>> {
  if (ids.length === 0) return [];
  const endpoint = taxonomy === "categories" ? "categories" : "tags";
  try {
    const res = await fetch(
      `${baseUrl}/wp-json/wp/v2/${endpoint}?include=${ids.join(",")}&per_page=100`,
      {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (res.ok) {
      const data = (await res.json()) as Array<{ id: number; name: string }>;
      return data.map((t) => ({ id: t.id, name: t.name }));
    }
  } catch {
    // Ignore
  }
  return ids.map((id) => ({ id, name: `${taxonomy === "categories" ? "Category" : "Tag"} ${id}` }));
}

// ─── Main import function ─────────────────────────────────────────────────────

export interface ImportOptions {
  statusFilter: "published" | "scheduled" | "draft" | "all";
  /** Maximum posts to import per run (default: 500) */
  maxPosts?: number;
}

export interface ImportResult {
  posts: WpImportedPost[];
  totalFound: number;
  errors: string[];
}

/**
 * Imports all posts from a WordPress site matching the status filter.
 * Handles pagination (per_page=100), author name resolution, featured images,
 * categories, tags, and Yoast/RankMath focus keyword extraction.
 *
 * NEVER imports trash posts regardless of filter selection.
 */
export async function importWordPressPosts(
  creds: WordPressCredentials,
  options: ImportOptions
): Promise<ImportResult> {
  const baseUrl = normaliseUrl(creds.siteUrl);
  const authHeader = buildAuthHeader(creds.username, creds.applicationPassword);
  const wpStatus = STATUS_FILTER_MAP[options.statusFilter] ?? "publish,future,draft";
  const maxPosts = options.maxPosts ?? 500;

  const allPosts: WpImportedPost[] = [];
  const errors: string[] = [];
  const authorCache = new Map<number, string>();
  let page = 1;
  let totalPages = 1;

  // ─── Pagination loop ───────────────────────────────────────────────────────
  while (page <= totalPages && allPosts.length < maxPosts) {
    // Use _embed=true to get author, featured media, and taxonomy terms in one request
    // This avoids N+1 API calls and is the recommended WP REST API approach
    const url = `${baseUrl}/wp-json/wp/v2/posts?status=${wpStatus}&per_page=100&page=${page}&_embed=true`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: any) {
      if (err?.name === "TimeoutError") {
        throw new WpImportException("site_unreachable", "Connection timed out during import. Please check the site is online.");
      }
      throw new WpImportException("site_unreachable", "Could not reach the website during import. Please check it is online and try again.");
    }

    if (res.status === 401) throw new WpImportException("invalid_credentials", "We could not connect to your WordPress site. Please check your URL, username, and application password.");
    if (res.status === 403) throw new WpImportException("insufficient_permissions", "Your WordPress user does not have permission to read or edit posts. Please use an Administrator account.");
    if (res.status === 429) throw new WpImportException("rate_limit", "Import paused — too many requests. We will continue automatically in 60 seconds.");
    if (!res.ok) throw new WpImportException("site_unreachable", `Unexpected response from WordPress (HTTP ${res.status}).`);

    // Read total pages from headers
    const totalPagesHeader = res.headers.get("X-WP-TotalPages");
    const totalHeader = res.headers.get("X-WP-Total");
    if (page === 1) {
      totalPages = totalPagesHeader ? parseInt(totalPagesHeader, 10) : 1;
    }

    const rawPosts = (await res.json()) as any[];

    if (page === 1 && rawPosts.length === 0) {
      throw new WpImportException("zero_posts", "No posts were found with the selected status. Try selecting All post types.");
    }

    // ─── Process each post ─────────────────────────────────────────────────
    for (const raw of rawPosts) {
      try {
        // Map WP status → our enum (NEVER import trash)
        const wpRawStatus: string = raw.status ?? "draft";
        if (wpRawStatus === "trash") continue; // Explicit guard — trash never imported
        const mappedStatus: WpPostStatus = WP_STATUS_MAP[wpRawStatus] ?? "draft";

        // Dates
        const publishDate =
          mappedStatus === "published" && raw.date_gmt
            ? new Date(raw.date_gmt + "Z")
            : null;
        const scheduledDate =
          mappedStatus === "scheduled" && raw.date_gmt
            ? new Date(raw.date_gmt + "Z")
            : null;

        // Author — use _embedded if available (avoids separate API call)
        const authorId: number = raw.author ?? 0;
        let authorName: string;
        if (raw._embedded?.author?.[0]?.name) {
          authorName = raw._embedded.author[0].name as string;
          authorCache.set(authorId, authorName);
        } else {
          authorName = await fetchAuthorName(baseUrl, authHeader, authorId, authorCache);
        }

        // Focus keyword — Yoast first, then RankMath (meta namespace only), then null.
        // Validated with shared validateKeyword before saving (2–5 words, not all stop words).
        let focusKeyword: string | null = null;
        const rawYoastKw = raw.meta?.["_yoast_wpseo_focuskw"] as string | undefined;
        const rawRankMathKw = raw.meta?.["rank_math_focus_keyword"] as string | undefined;
        const rawCmsKw = rawYoastKw || rawRankMathKw || null;
        if (rawCmsKw && validateKeyword(rawCmsKw)) {
          focusKeyword = rawCmsKw.trim().toLowerCase();
        }

        // Meta title & description from Yoast
        const metaTitle: string | null =
          raw.yoast_head_json?.title ?? raw.meta?.["_yoast_wpseo_title"] ?? null;
        const metaDescription: string | null =
          raw.yoast_head_json?.description ?? raw.meta?.["_yoast_wpseo_metadesc"] ?? null;

        // Featured image — use _embedded if available (avoids separate API call)
        let featuredImageUrl: string | null = null;
        let featuredImageAlt: string | null = null;
        if (raw._embedded?.["wp:featuredmedia"]?.[0]) {
          const media = raw._embedded["wp:featuredmedia"][0] as any;
          featuredImageUrl = media.source_url ?? null;
          featuredImageAlt = media.alt_text ?? null;
        } else if (raw.featured_media && raw.featured_media > 0) {
          const img = await fetchFeaturedImage(baseUrl, authHeader, raw.featured_media as number);
          featuredImageUrl = img.url;
          featuredImageAlt = img.alt;
        }

        // Body image alts
        const bodyHtml: string = raw.content?.rendered ?? "";
        const bodyImageAlts = extractBodyImageAlts(bodyHtml);

        // Categories & tags — use _embedded if available (avoids separate API calls)
        let categories: string[] = [];
        let tags: string[] = [];
        if (raw._embedded?.["wp:term"]) {
          const terms = raw._embedded["wp:term"] as Array<Array<{ id: number; name: string; taxonomy: string }>>;
          categories = (terms[0] ?? []).filter((t) => t.taxonomy === "category" || !t.taxonomy).map((t) => t.name);
          tags = (terms[1] ?? []).filter((t) => t.taxonomy === "post_tag" || !t.taxonomy).map((t) => t.name);
        } else {
          const categoryIds: number[] = Array.isArray(raw.categories) ? raw.categories : [];
          const tagIds: number[] = Array.isArray(raw.tags) ? raw.tags : [];
          const [catTerms, tagTerms] = await Promise.all([
            fetchTermNames(baseUrl, authHeader, "categories", categoryIds),
            fetchTermNames(baseUrl, authHeader, "tags", tagIds),
          ]);
          categories = catTerms.map((t) => t.name);
          tags = tagTerms.map((t) => t.name);
        }

        allPosts.push({
          cmsPostId: String(raw.id),
          title: raw.title?.rendered ?? "Untitled",
          bodyHtml,
          url: raw.link ?? "",
          status: mappedStatus,
          publishDate,
          scheduledDate,
          authorIdCms: String(authorId),
          authorNameCms: authorName,
          focusKeyword: focusKeyword || null,
          metaTitle,
          metaDescription,
          featuredImageUrl,
          featuredImageAlt,
          bodyImageAlts,
          categories,
          tags,
        });
      } catch (err: any) {
        // Don't fail the whole import for a single post error
        errors.push(`Post ${raw.id}: ${err?.message ?? "Unknown error"}`);
      }
    }

    page++;
  }

  return {
    posts: allPosts,
    totalFound: allPosts.length,
    errors,
  };
}
