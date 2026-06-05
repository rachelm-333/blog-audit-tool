/**
 * iAudit — Wix Blog API Integration (Layer 13 / Section 16.2)
 *
 * Auth: wix-api-key + wix-site-id headers
 * Base URL: https://www.wixapis.com/blog/v3/
 *
 * Import: GET /blog/v3/posts (with SEO data)
 * Post-back: PATCH /blog/v3/posts/{id} — body + meta only
 * Schema: NEVER auto-inject via Wix API — always show copyable JSON-LD block
 *
 * Status mapping:
 *   PUBLISHED  → published
 *   SCHEDULED  → scheduled
 *   DRAFT      → draft
 *   (DELETED is never imported)
 */

import type { WixCredentials } from "./encryption.service";
import { extractBodyImageAlts } from "./wordpress.service";
import type { WpImportedPost, WpPostStatus } from "./wordpress.service";

// ─── Constants ────────────────────────────────────────────────────────────────

const WIX_BASE = "https://www.wixapis.com/v3";

// ─── Error types ──────────────────────────────────────────────────────────────

export type WixImportError =
  | "invalid_credentials"
  | "insufficient_permissions"
  | "site_unreachable"
  | "rate_limit"
  | "zero_posts";

export class WixImportException extends Error {
  constructor(
    public readonly code: WixImportError,
    message: string
  ) {
    super(message);
    this.name = "WixImportException";
  }
}

// ─── Status mapping ───────────────────────────────────────────────────────────

const WIX_STATUS_MAP: Record<string, WpPostStatus> = {
  PUBLISHED: "published",
  SCHEDULED: "scheduled",
  DRAFT: "draft",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildHeaders(creds: WixCredentials): Record<string, string> {
  return {
    "Authorization": `Bearer ${creds.apiKey}`,
    "wix-site-id": creds.siteId,
    "Content-Type": "application/json",
  };
}

async function wixFetch(
  url: string,
  creds: WixCredentials,
  options: RequestInit = {}
): Promise<Response> {
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        ...buildHeaders(creds),
        ...(options.headers as Record<string, string> ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    return res;
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      throw new WixImportException("site_unreachable", "Connection to Wix timed out. Please try again.");
    }
    throw new WixImportException("site_unreachable", "Could not reach the Wix API. Please check your credentials and try again.");
  }
}

// ─── Connection test ──────────────────────────────────────────────────────────

/**
 * Tests a Wix connection by fetching the first page of posts.
 * Returns { ok: true, siteId } on success, or { ok: false, errorCode, message } on failure.
 */
export async function testWixConnection(
  creds: WixCredentials
): Promise<{ ok: true; siteId: string } | { ok: false; errorCode: string; message: string }> {
  let res: Response;
  try {
    const url = `${WIX_BASE}/posts?fieldsets=SEO&paging.limit=1&paging.offset=0`;
    res = await wixFetch(url, creds);
  } catch {
    return { ok: false, errorCode: "site_unreachable", message: "Could not reach the Wix API. Please check your credentials and try again." };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, errorCode: "invalid_credentials", message: "We could not connect to your Wix site. Please check your Site ID and API Key." };
  }
  if (res.status === 429) {
    return { ok: false, errorCode: "rate_limit", message: "Too many requests to Wix API. Please try again in a moment." };
  }
  if (!res.ok) {
    return { ok: false, errorCode: "site_unreachable", message: `Unexpected response from Wix API (HTTP ${res.status}).` };
  }

  return { ok: true, siteId: creds.siteId };
}

// ─── Import ───────────────────────────────────────────────────────────────────

export interface WixImportResult {
  posts: WpImportedPost[];
  errors: string[];
}

/**
 * Imports all blog posts from a Wix site.
 * Paginates through all pages using cursor-based pagination.
 */
export async function importWixPosts(
  creds: WixCredentials,
  statusFilter: "published" | "scheduled" | "draft" | "all" = "all"
): Promise<WixImportResult> {
  const allPosts: WpImportedPost[] = [];
  const errors: string[] = [];
  let cursor: string | null = null;
  let page = 0;

  do {
    page++;
    const params = new URLSearchParams({
      "fieldsets": "SEO",
      "paging.limit": "100",
    });
    if (cursor) params.set("paging.cursor", cursor);

    const url = `${WIX_BASE}/posts?${params.toString()}`;
    // Note: Wix Blog v3 API uses /v3/posts with Authorization: Bearer <api-key> + wix-site-id header
    const res = await wixFetch(url, creds);

    if (res.status === 401 || res.status === 403) {
      throw new WixImportException(
        "invalid_credentials",
        "We could not connect to your Wix site. Please check your Site ID and API Key."
      );
    }
    if (res.status === 429) {
      throw new WixImportException("rate_limit", "Import paused — too many requests to Wix API. Please try again in 60 seconds.");
    }
    if (!res.ok) {
      throw new WixImportException("site_unreachable", `Unexpected response from Wix API (HTTP ${res.status}).`);
    }

    const body = await res.json() as any;
        const rawPosts: any[] = body.posts ?? [];

    for (const raw of rawPosts) {
      try {
        const rawStatus: string = raw.status ?? "DRAFT";
        // Never import DELETED posts
        if (rawStatus === "DELETED") continue;
        const mappedStatus: WpPostStatus = WIX_STATUS_MAP[rawStatus] ?? "draft";

        // Dates
        const publishDate =
          mappedStatus === "published" && raw.firstPublishedDate
            ? new Date(raw.firstPublishedDate)
            : null;
        const scheduledDate =
          mappedStatus === "scheduled" && raw.scheduledPublishTime
            ? new Date(raw.scheduledPublishTime)
            : null;

        // Author
        const authorIdCms: string = raw.author?.id ?? "";
        const authorNameCms: string = raw.author?.authorName ?? raw.author?.fullName ?? "Unknown";

        // Focus keyword — from seoData.tags or seoData.keywords
        let focusKeyword: string | null = null;
        if (raw.seoData?.tags && Array.isArray(raw.seoData.tags)) {
          // Look for a meta tag with name "keywords" or a custom keyword tag
          const kwTag = raw.seoData.tags.find(
            (t: any) => t.type === "meta" && (t.props?.name === "keywords" || t.props?.name === "focusKeyword")
          );
          if (kwTag?.props?.content) {
            // Take the first keyword if comma-separated
            focusKeyword = (kwTag.props.content as string).split(",")[0]?.trim() ?? null;
          }
        }
        if (!focusKeyword && raw.seoData?.keywords) {
          const kw = raw.seoData.keywords;
          focusKeyword = Array.isArray(kw) ? (kw[0] ?? null) : (typeof kw === "string" ? kw.split(",")[0]?.trim() ?? null : null);
        }

        // Meta title & description from seoData
        let metaTitle: string | null = null;
        let metaDescription: string | null = null;
        if (raw.seoData?.tags && Array.isArray(raw.seoData.tags)) {
          for (const tag of raw.seoData.tags) {
            if (tag.type === "title") metaTitle = tag.children ?? null;
            if (tag.type === "meta" && tag.props?.name === "description") metaDescription = tag.props.content ?? null;
          }
        }

        // Body content — Wix returns rich content; use plainContent or excerpt as fallback
        const bodyHtml: string = raw.richContent?.nodes
          ? extractWixBodyHtml(raw.richContent)
          : (raw.excerpt ?? "");

        // Body image alts
        const bodyImageAlts = extractBodyImageAlts(bodyHtml);

        // Featured image
        const featuredImageUrl: string | null = raw.media?.wixMedia?.image?.url ?? raw.coverMedia?.image?.url ?? null;
        const featuredImageAlt: string | null = raw.media?.wixMedia?.image?.altText ?? null;

        // URL
        const url: string = raw.url?.base
          ? `${raw.url.base}${raw.url.path ?? ""}`
          : (raw.url?.path ?? "");

        // Apply status filter (client-side — Wix API returns all statuses)
        if (statusFilter !== "all" && mappedStatus !== statusFilter) continue;
        allPosts.push({
          cmsPostId: raw.id as string,
          title: raw.title as string ?? "",
          bodyHtml,
          url,
          status: mappedStatus,
          publishDate,
          scheduledDate,
          authorIdCms,
          authorNameCms,
          focusKeyword,
          metaTitle,
          metaDescription,
          featuredImageUrl,
          featuredImageAlt,
          bodyImageAlts,
          categories: [],
          tags: Array.isArray(raw.tags) ? raw.tags.map((t: any) => (typeof t === "string" ? t : t.label ?? "")) : [],
        });
      } catch (err: any) {
        errors.push(`Post ${raw.id ?? "unknown"}: ${err?.message ?? "Parse error"}`);
      }
    }

        // Cursor-based pagination
    cursor = body.metaData?.cursor ?? null;
    // Stop if no more pages
    if (!cursor || rawPosts.length === 0) break;
  } while (cursor && page < 50); // Safety cap at 5000 posts
  // Only throw zero_posts if the site truly has no posts at all (not just filtered out)
  // We check this by seeing if we got zero raw posts on the first page
  return { posts: allPosts, errors };
}

/**
 * Converts Wix rich content nodes to basic HTML.
 * Wix rich content is a structured JSON format — we extract text nodes.
 */
function extractWixBodyHtml(richContent: any): string {
  if (!richContent?.nodes) return "";
  const parts: string[] = [];

  function processNode(node: any): void {
    if (!node) return;
    switch (node.type) {
      case "PARAGRAPH":
      case "HEADING": {
        const text = (node.nodes ?? [])
          .filter((n: any) => n.type === "TEXT")
          .map((n: any) => n.textData?.text ?? "")
          .join("");
        if (text.trim()) {
          const tag = node.type === "HEADING" ? `h${node.headingData?.level ?? 2}` : "p";
          parts.push(`<${tag}>${text}</${tag}>`);
        }
        break;
      }
      case "IMAGE": {
        const src = node.imageData?.image?.src?.url ?? "";
        const alt = node.imageData?.altText ?? "";
        if (src) parts.push(`<img src="${src}" alt="${alt}" />`);
        break;
      }
      case "BULLETED_LIST":
      case "ORDERED_LIST": {
        const tag = node.type === "ORDERED_LIST" ? "ol" : "ul";
        const items = (node.nodes ?? [])
          .filter((n: any) => n.type === "LIST_ITEM")
          .map((n: any) => {
            const text = (n.nodes ?? [])
              .flatMap((p: any) => (p.nodes ?? []))
              .filter((t: any) => t.type === "TEXT")
              .map((t: any) => t.textData?.text ?? "")
              .join("");
            return `<li>${text}</li>`;
          })
          .join("");
        if (items) parts.push(`<${tag}>${items}</${tag}>`);
        break;
      }
      default:
        // Recurse into child nodes
        (node.nodes ?? []).forEach(processNode);
    }
  }

  (richContent.nodes ?? []).forEach(processNode);
  return parts.join("\n");
}

// ─── Post-back ────────────────────────────────────────────────────────────────

export interface WixPostBackPayload {
  cmsPostId: string;
  bodyApproved: string;
  metaTitle: string;
  metaDescription: string;
}

export interface WixPostBackResult {
  success: true;
  /** Wix never supports auto-injection — always provide copyable JSON-LD */
  schemaInjected: false;
  schemaFallbackJson: string | null;
}

/**
 * Posts back approved content to a Wix blog post.
 * ONLY updates: content, meta title, meta description.
 * NEVER updates: author, date, status, URL.
 * Schema injection is NOT supported by Wix API — always returns schemaFallbackJson.
 */
export async function postBackToWix(
  creds: WixCredentials,
  payload: WixPostBackPayload,
  schemaJson: unknown | null
): Promise<WixPostBackResult> {
  const url = `${WIX_BASE}/posts/${payload.cmsPostId}`;
  // Wix Blog v3 PATCH — Authorization: Bearer <api-key> + wix-site-id header

  // Build SEO tags for meta title and description
  const seoData = {
    tags: [
      { type: "title", children: payload.metaTitle },
      {
        type: "meta",
        props: { name: "description", content: payload.metaDescription },
      },
    ],
  };

  // Wix PATCH — only content and SEO data
  const patchBody = {
    post: {
      content: payload.bodyApproved,
      seoData,
    },
    fieldMask: "content,seoData",
  };

  const res = await wixFetch(url, creds, {
    method: "PATCH",
    body: JSON.stringify(patchBody),
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("insufficient_permissions");
  }
  if (res.status === 404) {
    throw new Error("post_not_found");
  }
  if (!res.ok) {
    throw new Error(`site_unreachable:HTTP ${res.status}`);
  }

  // Schema fallback — Wix never supports auto-injection
  const schemaFallbackJson = schemaJson ? JSON.stringify(schemaJson, null, 2) : null;

  return {
    success: true,
    schemaInjected: false,
    schemaFallbackJson,
  };
}
