/**
 * iAudit — Shopify Admin API Integration (Layer 13 / Section 16.3)
 *
 * Auth: X-Shopify-Access-Token header
 * Base URL: https://{shop}.myshopify.com/admin/api/2024-01/
 *
 * Import: GET /blogs/{blog_id}/articles.json + metafields per article
 * Post-back: PUT /blogs/{blog_id}/articles/{id}.json (fetch-then-merge)
 *   - Meta title/description stored in metafields (namespace: global, key: title_tag / description_tag)
 *
 * Status mapping:
 *   published  → published
 *   scheduled  → scheduled (future-dated published_at)
 *   draft      → draft
 */

import type { ShopifyCredentials } from "./encryption.service";
import { extractBodyImageAlts } from "./wordpress.service";
import type { WpImportedPost, WpPostStatus } from "./wordpress.service";

// ─── Error types ──────────────────────────────────────────────────────────────

export type ShopifyImportError =
  | "invalid_credentials"
  | "insufficient_permissions"
  | "site_unreachable"
  | "rate_limit"
  | "zero_posts"
  | "no_blogs";

export class ShopifyImportException extends Error {
  constructor(
    public readonly code: ShopifyImportError,
    message: string
  ) {
    super(message);
    this.name = "ShopifyImportException";
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseShop(shop: string): string {
  // Strip protocol if present
  return shop.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function buildBaseUrl(shop: string): string {
  return `https://${normaliseShop(shop)}/admin/api/2024-01`;
}

function buildHeaders(creds: ShopifyCredentials): Record<string, string> {
  return {
    "X-Shopify-Access-Token": creds.accessToken,
    "Content-Type": "application/json",
  };
}

async function shopifyFetch(
  url: string,
  creds: ShopifyCredentials,
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
      throw new ShopifyImportException("site_unreachable", "Connection to Shopify timed out. Please try again.");
    }
    throw new ShopifyImportException("site_unreachable", "Could not reach the Shopify Admin API. Please check your store URL and access token.");
  }
}

// ─── Connection test ──────────────────────────────────────────────────────────

/**
 * Tests a Shopify connection by listing blogs.
 * Returns { ok: true, shop, firstBlogId } on success, or { ok: false, errorCode, message } on failure.
 */
export async function testShopifyConnection(
  creds: ShopifyCredentials
): Promise<
  | { ok: true; shop: string; firstBlogId: string | null }
  | { ok: false; errorCode: string; message: string }
> {
  let res: Response;
  try {
    const baseUrl = buildBaseUrl(creds.shop);
    res = await shopifyFetch(`${baseUrl}/blogs.json?limit=1`, creds);
  } catch {
    return { ok: false, errorCode: "site_unreachable", message: "Could not reach the Shopify Admin API. Please check your store URL and access token." };
  }

  if (res.status === 401) {
    return { ok: false, errorCode: "invalid_credentials", message: "We could not connect to your Shopify store. Please check your store URL and Admin API access token." };
  }
  if (res.status === 403) {
    return { ok: false, errorCode: "insufficient_permissions", message: "Your Shopify access token does not have permission to read blog posts. Please check the token scopes." };
  }
  if (res.status === 429) {
    return { ok: false, errorCode: "rate_limit", message: "Too many requests to Shopify API. Please try again in a moment." };
  }
  if (!res.ok) {
    return { ok: false, errorCode: "site_unreachable", message: `Unexpected response from Shopify (HTTP ${res.status}).` };
  }

  const body = await res.json() as any;
  const blogs: any[] = body.blogs ?? [];
  const firstBlogId = blogs[0]?.id?.toString() ?? null;

  return { ok: true, shop: normaliseShop(creds.shop), firstBlogId };
}

// ─── Import ───────────────────────────────────────────────────────────────────

export interface ShopifyImportResult {
  posts: WpImportedPost[];
  errors: string[];
}

/**
 * Imports all blog articles from a Shopify store.
 * Fetches all blogs first, then paginates through articles for each blog.
 * Fetches metafields per article for focus keyword.
 */
export async function importShopifyPosts(
  creds: ShopifyCredentials
): Promise<ShopifyImportResult> {
  const baseUrl = buildBaseUrl(creds.shop);
  const allPosts: WpImportedPost[] = [];
  const errors: string[] = [];

  // 1. Get all blogs
  const blogsRes = await shopifyFetch(`${baseUrl}/blogs.json`, creds);
  if (!blogsRes.ok) {
    throw new ShopifyImportException("site_unreachable", `Could not fetch blogs from Shopify (HTTP ${blogsRes.status}).`);
  }
  const blogsBody = await blogsRes.json() as any;
  const blogs: any[] = blogsBody.blogs ?? [];

  if (blogs.length === 0) {
    throw new ShopifyImportException("no_blogs", "No blogs were found on this Shopify store. Please create a blog first.");
  }

  // 2. For each blog, paginate through articles
  for (const blog of blogs) {
    const blogId = blog.id as number;
    let pageInfo: string | null = null;
    let firstPage = true;

    do {
      const params = new URLSearchParams({ limit: "250" });
      if (pageInfo) params.set("page_info", pageInfo);

      const articlesRes = await shopifyFetch(
        `${baseUrl}/blogs/${blogId}/articles.json?${params.toString()}`,
        creds
      );

      if (articlesRes.status === 401) {
        throw new ShopifyImportException("invalid_credentials", "We could not connect to your Shopify store. Please check your access token.");
      }
      if (articlesRes.status === 403) {
        throw new ShopifyImportException("insufficient_permissions", "Your Shopify access token does not have permission to read articles.");
      }
      if (articlesRes.status === 429) {
        throw new ShopifyImportException("rate_limit", "Import paused — too many requests to Shopify API. Please try again in 60 seconds.");
      }
      if (!articlesRes.ok) {
        errors.push(`Blog ${blogId}: HTTP ${articlesRes.status}`);
        break;
      }

      const articlesBody = await articlesRes.json() as any;
      const articles: any[] = articlesBody.articles ?? [];

      if (firstPage && articles.length === 0 && blogs.length === 1) {
        throw new ShopifyImportException("zero_posts", "No articles were found in this Shopify blog.");
      }
      firstPage = false;

      // Process each article
      for (const article of articles) {
        try {
          // Fetch metafields for focus keyword
          let focusKeyword: string | null = null;
          let metaTitle: string | null = null;
          let metaDescription: string | null = null;

          try {
            const metaRes = await shopifyFetch(
              `${baseUrl}/articles/${article.id}/metafields.json`,
              creds
            );
            if (metaRes.ok) {
              const metaBody = await metaRes.json() as any;
              const metafields: any[] = metaBody.metafields ?? [];
              for (const mf of metafields) {
                if (mf.namespace === "seo" && mf.key === "focus_keyword") {
                  focusKeyword = mf.value ?? null;
                }
                if (mf.namespace === "global" && mf.key === "title_tag") {
                  metaTitle = mf.value ?? null;
                }
                if (mf.namespace === "global" && mf.key === "description_tag") {
                  metaDescription = mf.value ?? null;
                }
              }
            }
          } catch {
            // Metafield fetch failure is non-fatal
          }

          // Status mapping
          // Shopify: published_at set + published = true → published
          // published_at in the future → scheduled
          // no published_at or published = false → draft
          let mappedStatus: WpPostStatus = "draft";
          let publishDate: Date | null = null;
          let scheduledDate: Date | null = null;

          if (article.published_at) {
            const pubDate = new Date(article.published_at);
            const now = new Date();
            if (pubDate > now) {
              mappedStatus = "scheduled";
              scheduledDate = pubDate;
            } else {
              mappedStatus = "published";
              publishDate = pubDate;
            }
          }

          // Body HTML
          const bodyHtml: string = article.body_html ?? "";
          const bodyImageAlts = extractBodyImageAlts(bodyHtml);

          // URL — Shopify article URL: /{blog.handle}/{article.handle}
          const articleUrl = `https://${normaliseShop(creds.shop)}/blogs/${blog.handle}/${article.handle}`;

          // Author — Shopify stores author name only (no separate author_id)
          const authorNameCms: string = article.author ?? "Unknown";
          const authorIdCms: string = article.author ?? ""; // No native author ID in Shopify

          allPosts.push({
            cmsPostId: article.id.toString(),
            title: article.title ?? "",
            bodyHtml,
            url: articleUrl,
            status: mappedStatus,
            publishDate,
            scheduledDate,
            authorIdCms,
            authorNameCms,
            focusKeyword,
            metaTitle,
            metaDescription,
            featuredImageUrl: article.image?.src ?? null,
            featuredImageAlt: article.image?.alt ?? null,
            bodyImageAlts,
            categories: [blog.title ?? ""],
            tags: article.tags ? article.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [],
          });
        } catch (err: any) {
          errors.push(`Article ${article.id ?? "unknown"}: ${err?.message ?? "Parse error"}`);
        }
      }

      // Shopify cursor pagination via Link header
      const linkHeader = articlesRes.headers.get("Link") ?? "";
      const nextMatch = linkHeader.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      pageInfo = nextMatch ? nextMatch[1]! : null;
    } while (pageInfo);
  }

  return { posts: allPosts, errors };
}

// ─── Post-back ────────────────────────────────────────────────────────────────

export interface ShopifyPostBackPayload {
  cmsPostId: string;
  blogId: string; // Shopify requires blog_id for article update
  bodyApproved: string;
  metaTitle: string;
  metaDescription: string;
}

export interface ShopifyPostBackResult {
  success: true;
  schemaInjected: boolean;
  schemaFallbackJson: string | null;
}

/**
 * Posts back approved content to a Shopify article.
 * Fetch-then-merge: fetches current article state first, then PUTs only changed fields.
 * Meta title/description are stored as metafields (global.title_tag / global.description_tag).
 * Schema injection attempted via metafield (global.schema_json); falls back to copyable block.
 */
export async function postBackToShopify(
  creds: ShopifyCredentials,
  payload: ShopifyPostBackPayload,
  schemaJson: unknown | null
): Promise<ShopifyPostBackResult> {
  const baseUrl = buildBaseUrl(creds.shop);

  // 1. Fetch current article state (fetch-then-merge)
  const fetchRes = await shopifyFetch(
    `${baseUrl}/blogs/${payload.blogId}/articles/${payload.cmsPostId}.json`,
    creds
  );

  if (fetchRes.status === 404) throw new Error("post_not_found");
  if (fetchRes.status === 401 || fetchRes.status === 403) throw new Error("insufficient_permissions");
  if (!fetchRes.ok) throw new Error(`site_unreachable:HTTP ${fetchRes.status}`);

  const currentArticle = (await fetchRes.json() as any).article ?? {};

  // 2. Merge only the approved fields — preserve everything else
  const updatePayload = {
    article: {
      ...currentArticle,
      body_html: payload.bodyApproved,
      // Do NOT include: author, published_at, status, handle, title (preserve originals)
    },
  };

  const putRes = await shopifyFetch(
    `${baseUrl}/blogs/${payload.blogId}/articles/${payload.cmsPostId}.json`,
    creds,
    {
      method: "PUT",
      body: JSON.stringify(updatePayload),
    }
  );

  if (putRes.status === 404) throw new Error("post_not_found");
  if (putRes.status === 401 || putRes.status === 403) throw new Error("insufficient_permissions");
  if (!putRes.ok) throw new Error(`site_unreachable:HTTP ${putRes.status}`);

  // 3. Update meta title and description via metafields
  let metaWritten = false;
  try {
    // Fetch existing metafields to find IDs for update vs create
    const existingMetaRes = await shopifyFetch(
      `${baseUrl}/articles/${payload.cmsPostId}/metafields.json`,
      creds
    );
    const existingMeta: any[] = existingMetaRes.ok
      ? ((await existingMetaRes.json() as any).metafields ?? [])
      : [];

    const titleMf = existingMeta.find((m: any) => m.namespace === "global" && m.key === "title_tag");
    const descMf = existingMeta.find((m: any) => m.namespace === "global" && m.key === "description_tag");

    // Upsert title_tag
    if (titleMf) {
      await shopifyFetch(`${baseUrl}/metafields/${titleMf.id}.json`, creds, {
        method: "PUT",
        body: JSON.stringify({ metafield: { id: titleMf.id, value: payload.metaTitle, type: "single_line_text_field" } }),
      });
    } else {
      await shopifyFetch(`${baseUrl}/articles/${payload.cmsPostId}/metafields.json`, creds, {
        method: "POST",
        body: JSON.stringify({ metafield: { namespace: "global", key: "title_tag", value: payload.metaTitle, type: "single_line_text_field" } }),
      });
    }

    // Upsert description_tag
    if (descMf) {
      await shopifyFetch(`${baseUrl}/metafields/${descMf.id}.json`, creds, {
        method: "PUT",
        body: JSON.stringify({ metafield: { id: descMf.id, value: payload.metaDescription, type: "single_line_text_field" } }),
      });
    } else {
      await shopifyFetch(`${baseUrl}/articles/${payload.cmsPostId}/metafields.json`, creds, {
        method: "POST",
        body: JSON.stringify({ metafield: { namespace: "global", key: "description_tag", value: payload.metaDescription, type: "single_line_text_field" } }),
      });
    }

    metaWritten = true;
  } catch {
    // Meta update failure — partial_failure
    throw new Error(`partial_failure:content_written_meta_failed`);
  }

  // 4. Attempt schema injection via metafield
  let schemaInjected = false;
  const schemaFallbackJson = schemaJson ? JSON.stringify(schemaJson, null, 2) : null;

  if (schemaJson && metaWritten) {
    try {
      const existingMetaRes2 = await shopifyFetch(
        `${baseUrl}/articles/${payload.cmsPostId}/metafields.json`,
        creds
      );
      const existingMeta2: any[] = existingMetaRes2.ok
        ? ((await existingMetaRes2.json() as any).metafields ?? [])
        : [];
      const schemaMf = existingMeta2.find((m: any) => m.namespace === "global" && m.key === "schema_json");

      if (schemaMf) {
        const r = await shopifyFetch(`${baseUrl}/metafields/${schemaMf.id}.json`, creds, {
          method: "PUT",
          body: JSON.stringify({ metafield: { id: schemaMf.id, value: JSON.stringify(schemaJson), type: "json" } }),
        });
        schemaInjected = r.ok;
      } else {
        const r = await shopifyFetch(`${baseUrl}/articles/${payload.cmsPostId}/metafields.json`, creds, {
          method: "POST",
          body: JSON.stringify({ metafield: { namespace: "global", key: "schema_json", value: JSON.stringify(schemaJson), type: "json" } }),
        });
        schemaInjected = r.ok;
      }
    } catch {
      schemaInjected = false;
    }
  }

  return {
    success: true,
    schemaInjected,
    schemaFallbackJson: schemaInjected ? null : schemaFallbackJson,
  };
}

/**
 * Extracts the blog_id from a Shopify article URL or from stored connection metadata.
 * Falls back to fetching blogs and returning the first blog_id.
 */
export async function getShopifyBlogId(
  creds: ShopifyCredentials,
  articleId: string
): Promise<string> {
  const baseUrl = buildBaseUrl(creds.shop);

  // Try to find the article across all blogs
  const blogsRes = await shopifyFetch(`${baseUrl}/blogs.json`, creds);
  if (!blogsRes.ok) throw new Error("site_unreachable");

  const blogs: any[] = ((await blogsRes.json() as any).blogs ?? []);
  for (const blog of blogs) {
    const checkRes = await shopifyFetch(
      `${baseUrl}/blogs/${blog.id}/articles/${articleId}.json`,
      creds
    );
    if (checkRes.ok) return blog.id.toString();
  }

  throw new Error("post_not_found");
}
