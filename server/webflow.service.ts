/**
 * iAudit — Webflow CMS Integration
 *
 * Connects to the Webflow Data API v2 to:
 *   1. Test connection (validate API key + collection ID)
 *   2. Import CMS collection items as blog posts
 *   3. Extract focus keyword, meta title, meta description
 *   4. Map isDraft → published/draft status
 *
 * Webflow API docs: https://developers.webflow.com/data/reference
 * Auth: Bearer token (API key from Account Settings → API Access)
 * Endpoint: https://api.webflow.com/v2/collections/{collectionId}/items
 */

import type { WpImportedPost } from "./wordpress.service";
import { validateKeyword } from "./keyword.service";

export interface WebflowCredentials {
  apiKey: string;
  collectionId: string;
}

// ─── Custom error class ───────────────────────────────────────────────────────

export class WebflowImportException extends Error {
  constructor(
    public readonly code:
      | "invalid_credentials"
      | "insufficient_permissions"
      | "site_unreachable"
      | "rate_limit"
      | "zero_posts"
      | "invalid_collection",
    message: string
  ) {
    super(message);
    this.name = "WebflowImportException";
  }
}

// ─── API helpers ──────────────────────────────────────────────────────────────

const WEBFLOW_API_BASE = "https://api.webflow.com/v2";

async function webflowFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${WEBFLOW_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "accept-version": "1.0.0",
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  return res;
}

// ─── Test connection ──────────────────────────────────────────────────────────

export async function testWebflowConnection(
  creds: WebflowCredentials
): Promise<{ ok: boolean; message: string; collectionName?: string }> {
  let res: Response;
  try {
    res = await webflowFetch(`/collections/${creds.collectionId}`, creds.apiKey);
  } catch {
    throw new WebflowImportException(
      "site_unreachable",
      "Could not reach the Webflow API. Please check your internet connection and try again."
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new WebflowImportException(
      "invalid_credentials",
      "Invalid Webflow API key. Please check your key in Account Settings → API Access."
    );
  }

  if (res.status === 404) {
    throw new WebflowImportException(
      "invalid_collection",
      "Collection not found. Please check the Collection ID and ensure your API key has access to this site."
    );
  }

  if (res.status === 429) {
    throw new WebflowImportException(
      "rate_limit",
      "Webflow API rate limit reached. Please wait a moment and try again."
    );
  }

  if (!res.ok) {
    throw new WebflowImportException(
      "site_unreachable",
      `Webflow API error: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json() as { displayName?: string; slug?: string };
  return {
    ok: true,
    message: "Connected successfully",
    collectionName: data.displayName ?? data.slug ?? creds.collectionId,
  };
}

// ─── Status mapping ───────────────────────────────────────────────────────────

/**
 * Map Webflow item status to iAudit canonical status.
 * isDraft: false → published
 * isDraft: true  → draft
 * isArchived: true → draft (archived items treated as draft)
 */
function mapWebflowStatus(
  isDraft: boolean,
  isArchived?: boolean
): "published" | "draft" | "scheduled" {
  if (isArchived) return "draft";
  if (isDraft) return "draft";
  return "published";
}

// ─── Keyword extraction ───────────────────────────────────────────────────────

/**
 * Extract focus keyword from Webflow CMS item fieldData.
 * Priority order:
 *   1. seo-keywords or focus-keyword CMS field
 *   2. URL slug (strip hyphens, extract meaningful phrase)
 *   3. Post title (extractKeywordFromTitle)
 */
function extractWebflowKeyword(
  fieldData: Record<string, unknown>,
  slug: string,
  title: string,
  bodyHtml: string,
  metaTitle: string,
  metaDesc: string
): string | null {
  // 1. CMS SEO keyword field
  const seoField =
    (fieldData["seo-keywords"] as string | undefined) ??
    (fieldData["focus-keyword"] as string | undefined) ??
    (fieldData["seoKeywords"] as string | undefined) ??
    (fieldData["focusKeyword"] as string | undefined);

  if (seoField && typeof seoField === "string") {
    // May be comma-separated — take first entry
    const first = seoField.split(",")[0].trim();
    if (validateKeyword(first)) return first.toLowerCase();
  }

  // 2. URL slug — strip hyphens and extract meaningful phrase
  if (slug) {
    const slugPhrase = slug
      .replace(/-/g, " ")
      .replace(/[^a-z0-9\s]/gi, " ")
      .trim()
      .toLowerCase();
    if (validateKeyword(slugPhrase)) return slugPhrase;
  }

  // 3. Title extraction
  const { extractKeywordFromTitle } = require("./keyword.service");
  const fromTitle = extractKeywordFromTitle(title, bodyHtml, metaTitle, metaDesc);
  if (fromTitle && validateKeyword(fromTitle)) return fromTitle;

  return null;
}

// ─── Import posts ─────────────────────────────────────────────────────────────

interface WebflowItem {
  id: string;
  isDraft: boolean;
  isArchived: boolean;
  lastPublished?: string | null;
  createdOn?: string;
  fieldData: Record<string, unknown>;
  cmsLocaleId?: string;
}

interface WebflowItemsResponse {
  items: WebflowItem[];
  pagination?: {
    limit: number;
    offset: number;
    total: number;
  };
}

/**
 * Import all CMS items from a Webflow collection as blog posts.
 * Handles pagination automatically (100 items per page).
 */
export async function importWebflowPosts(
  creds: WebflowCredentials,
  statusFilter: "published" | "scheduled" | "draft" | "all" = "all"
): Promise<{ posts: WpImportedPost[]; errors: string[] }> {
  const allItems: WebflowItem[] = [];
  const errors: string[] = [];

  let offset = 0;
  const limit = 100;
  let total = Infinity;

  // Paginate through all items
  while (offset < total) {
    let res: Response;
    try {
      res = await webflowFetch(
        `/collections/${creds.collectionId}/items?limit=${limit}&offset=${offset}`,
        creds.apiKey
      );
    } catch {
      throw new WebflowImportException(
        "site_unreachable",
        "Could not reach the Webflow API during import."
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new WebflowImportException(
        "invalid_credentials",
        "Webflow API key is invalid or has been revoked."
      );
    }
    if (res.status === 404) {
      throw new WebflowImportException(
        "invalid_collection",
        "Webflow collection not found. Please verify the Collection ID."
      );
    }
    if (res.status === 429) {
      throw new WebflowImportException(
        "rate_limit",
        "Webflow API rate limit reached. Please wait and try again."
      );
    }
    if (!res.ok) {
      errors.push(`Webflow API error on page offset ${offset}: ${res.status}`);
      break;
    }

    const data = await res.json() as WebflowItemsResponse;
    allItems.push(...(data.items ?? []));

    if (data.pagination) {
      total = data.pagination.total;
      offset += limit;
    } else {
      break; // No pagination info — single page
    }
  }

  if (allItems.length === 0) {
    throw new WebflowImportException(
      "zero_posts",
      "No items were found in this Webflow collection."
    );
  }

  const importedPosts: WpImportedPost[] = [];

  for (const item of allItems) {
    try {
      const fd = item.fieldData;

      // ── Status ──────────────────────────────────────────────────────────────
      const status = mapWebflowStatus(item.isDraft, item.isArchived);

      // Apply status filter
      if (statusFilter !== "all" && status !== statusFilter) continue;

      // ── Title ────────────────────────────────────────────────────────────────
      const title =
        (fd["name"] as string | undefined) ??
        (fd["title"] as string | undefined) ??
        (fd["post-title"] as string | undefined) ??
        "Untitled";

      // ── Body HTML ────────────────────────────────────────────────────────────
      // Webflow rich text fields return HTML
      const bodyHtml =
        (fd["post-body"] as string | undefined) ??
        (fd["body"] as string | undefined) ??
        (fd["content"] as string | undefined) ??
        (fd["rich-text"] as string | undefined) ??
        "";

      // ── Slug / URL ───────────────────────────────────────────────────────────
      const slug = (fd["slug"] as string | undefined) ?? item.id;
      const url = slug.startsWith("http") ? slug : `/${slug}`;

      // ── Meta fields ──────────────────────────────────────────────────────────
      const metaTitle =
        (fd["meta-title"] as string | undefined) ??
        (fd["seo-title"] as string | undefined) ??
        title;

      const metaDesc =
        (fd["meta-description"] as string | undefined) ??
        (fd["seo-description"] as string | undefined) ??
        "";

      // ── Focus keyword ────────────────────────────────────────────────────────
      const focusKeyword = extractWebflowKeyword(
        fd,
        slug,
        title,
        bodyHtml,
        metaTitle,
        metaDesc
      );

      // ── Dates ────────────────────────────────────────────────────────────────
      const publishDate = item.lastPublished ? new Date(item.lastPublished) : null;
      const createdAt = item.createdOn ? new Date(item.createdOn) : new Date();

      // ── Author ───────────────────────────────────────────────────────────────
      // Webflow doesn't expose author on collection items by default
      const authorId = "webflow";
      const authorName = (fd["author"] as string | undefined) ?? "Webflow Author";

      // ── Featured image ───────────────────────────────────────────────────────
      const featuredImageField = fd["main-image"] ?? fd["thumbnail"] ?? fd["featured-image"];
      let featuredImageUrl: string | null = null;
      let featuredImageAlt: string | null = null;
      if (featuredImageField && typeof featuredImageField === "object") {
        const img = featuredImageField as { url?: string; alt?: string };
        featuredImageUrl = img.url ?? null;
        featuredImageAlt = img.alt ?? null;
      }

      importedPosts.push({
        cmsPostId: item.id,
        title,
        bodyHtml,
        url,
        status,
        publishDate: publishDate ?? (status === "published" ? createdAt : null),
        scheduledDate: null,
        authorIdCms: authorId,
        authorNameCms: authorName,
        focusKeyword,
        metaTitle: metaTitle || null,
        metaDescription: metaDesc || null,
        featuredImageUrl,
        featuredImageAlt,
        bodyImageAlts: [],
        categories: [],
        tags: [],
      });
    } catch (err: any) {
      errors.push(`Item ${item.id}: ${err?.message ?? "parse error"}`);
    }
  }

  return { posts: importedPosts, errors };
}
