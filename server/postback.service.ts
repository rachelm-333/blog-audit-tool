/**
 * iAudit — Post Back to CMS Service (Layer 9 / Section 13 + 16.1)
 *
 * Writes the approved, user-edited content back to the exact CMS post it came from.
 *
 * CRITICAL PRESERVATION RULES (non-negotiable):
 *   - author_id_cms MUST be included in every PATCH payload to preserve the original author
 *   - status, date_gmt, slug are NEVER included — omitting them preserves existing values
 *   - URL/permalink, categories, tags are NEVER changed
 *   - Only these fields are written: content (body_approved), meta title, meta description,
 *     image alt texts, and author
 *
 * WordPress PATCH endpoint: /wp-json/wp/v2/posts/{cms_post_id}
 * Auth: Application Password — Base64(username:app_password) in Authorization header
 *
 * Error states (Table 20 / Section 13.3):
 *   - connection_lost       → CMS connection is disconnected/error
 *   - post_not_found        → 404 from WP — post deleted in CMS
 *   - insufficient_permissions → 403 from WP — credentials lack write access
 *   - partial_failure       → content written but meta update failed
 */

import { JSDOM } from "jsdom";
import type { WordPressCredentials } from "./encryption.service";
import { normaliseUrl } from "./wordpress.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PostBackErrorCode =
  | "connection_lost"
  | "post_not_found"
  | "insufficient_permissions"
  | "partial_failure"
  | "site_unreachable"
  | "image_loss_risk"
  | "unknown";

export class PostBackException extends Error {
  constructor(
    public readonly code: PostBackErrorCode,
    message: string,
    public readonly partialData?: {
      contentWritten: boolean;
      metaTitle?: string;
      metaDescription?: string;
    }
  ) {
    super(message);
    this.name = "PostBackException";
  }
}

export interface PostBackPayload {
  cmsPostId: string;
  bodyApproved: string;
  bodyOriginal: string | null; // Original body — used to preserve images
  metaTitle: string;
  metaDescription: string;
  authorIdCms: string; // MUST be included — preserves original author
  bodyImageAlts: string[]; // Updated alt texts for images in the body
  schemaJson: unknown | null; // JSON-LD schema from Layer 7 — injected if supported
}

export interface PostBackResult {
  success: true;
  schemaInjected: boolean;
  schemaFallbackJson: string | null; // JSON-LD string to display if injection failed
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildAuthHeader(username: string, appPassword: string): string {
  const token = Buffer.from(`${username}:${appPassword}`).toString("base64");
  return `Basic ${token}`;
}

/**
 * Inject updated alt texts into the post body HTML.
 * Replaces alt attributes on <img> tags in order of appearance.
 * If there are more images than alt texts, remaining images are left unchanged.
 */
function injectAltTexts(bodyHtml: string, altTexts: string[]): string {
  if (!altTexts.length) return bodyHtml;
  let idx = 0;
  return bodyHtml.replace(/<img([^>]*?)>/gi, (match, attrs: string) => {
    if (idx >= altTexts.length) return match;
    const newAlt = altTexts[idx++]!;
    // Replace existing alt attribute or inject one
    if (/\balt=/i.test(attrs)) {
      const updated = attrs.replace(/\balt="[^"]*"/i, `alt="${escapeAttr(newAlt)}"`);
      return `<img${updated}>`;
    }
    return `<img${attrs} alt="${escapeAttr(newAlt)}">`;
  });
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Preserves images from the original body HTML by re-injecting them into the
 * rewritten body. ALL images are placed at the top of the post (after the first
 * paragraph) so the user can reposition them in their CMS editor.
 *
 * Proportional placement was removed because the rewritten body has different
 * paragraph counts, causing images to land in wrong positions.
 *
 * Strategy:
 *   1. Extract all <img> tags from the original body (in DOM order).
 *   2. Apply updated alt texts.
 *   3. Insert all images as <figure> blocks immediately after the first <p> in
 *      the rewritten body (or at the very top if no <p> exists).
 */
export function preserveImagesInBody(
  originalHtml: string,
  rewrittenHtml: string,
  updatedAltTexts: string[]
): string {
  if (!originalHtml || !rewrittenHtml) return rewrittenHtml;

  try {
    const origDom = new JSDOM(originalHtml);
    const origDoc = origDom.window.document;

    // Extract all img elements from original body in order
    const origImgs = Array.from(origDoc.querySelectorAll("img")) as Element[];
    if (origImgs.length === 0) return rewrittenHtml; // No images to preserve

    // Apply updated alt texts and collect HTML strings
    const imgHtmlList: string[] = origImgs.map((img, imgIdx) => {
      const altText = updatedAltTexts[imgIdx];
      if (altText !== undefined) {
        img.setAttribute("alt", altText);
      }
      return img.outerHTML;
    });

    // Work on the rewritten body
    const rewriteDom = new JSDOM(rewrittenHtml);
    const rewriteDoc = rewriteDom.window.document;
    const body = rewriteDoc.body;

    // Find the first <p> to insert images after it
    const firstPara = body.querySelector("p");

    // Build figure elements for all images
    const figures = imgHtmlList.map((imgHtml) => {
      const wrapper = rewriteDoc.createElement("figure");
      wrapper.className = "wp-block-image";
      wrapper.innerHTML = imgHtml;
      return wrapper;
    });

    if (firstPara && firstPara.parentNode) {
      // Insert all images right after the first paragraph, in reverse order
      // so they end up in the correct sequence (first image closest to top)
      const insertRef = firstPara.nextSibling;
      figures.reverse().forEach((fig) => {
        firstPara.parentNode!.insertBefore(fig, insertRef);
      });
    } else {
      // No paragraph found — prepend all images at the very top
      figures.reverse().forEach((fig) => {
        body.insertBefore(fig, body.firstChild);
      });
    }

    return body.innerHTML;
  } catch {
    // If anything fails, return the rewritten body unchanged rather than crashing
    return rewrittenHtml;
  }
}

/**
 * Attempt to inject schema JSON-LD into the post via the WordPress REST API.
 * Uses the Yoast SEO REST API field (yoast_head_json is read-only, but
 * _yoast_wpseo_schema_page_type can be set via meta). For maximum compatibility
 * we attempt to set the schema as a custom meta field.
 * Returns true if injection succeeded, false otherwise (caller shows fallback).
 */
async function attemptSchemaInjection(
  baseUrl: string,
  authHeader: string,
  cmsPostId: string,
  schemaJson: unknown
): Promise<boolean> {
  if (!schemaJson) return false;

  try {
    const schemaStr = typeof schemaJson === "string"
      ? schemaJson
      : JSON.stringify(schemaJson);

    // Attempt via Yoast custom schema override meta field
    const res = await fetch(`${baseUrl}/wp-json/wp/v2/posts/${cmsPostId}`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        meta: {
          _yoast_wpseo_schema_page_type: "Article",
          iaudit_schema_json: schemaStr, // custom meta field — may not exist on all sites
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    return res.ok;
  } catch {
    return false;
  }
}

// ─── Main post-back function ──────────────────────────────────────────────────

/**
 * Write approved content back to a WordPress post.
 *
 * PATCH /wp-json/wp/v2/posts/{cms_post_id}
 * Payload: { content, title (unchanged), author, meta: { yoast fields } }
 *
 * NEVER includes: status, date_gmt, slug, categories, tags
 */
export async function postBackToWordPress(
  creds: WordPressCredentials,
  payload: PostBackPayload
): Promise<PostBackResult> {
  const baseUrl = normaliseUrl(creds.siteUrl);
  const authHeader = buildAuthHeader(creds.username, creds.applicationPassword);
  const endpoint = `${baseUrl}/wp-json/wp/v2/posts/${payload.cmsPostId}`;

  // Preserve original images and inject updated alt texts into the body HTML
  const bodyWithImages = payload.bodyOriginal
    ? preserveImagesInBody(payload.bodyOriginal, payload.bodyApproved, payload.bodyImageAlts)
    : injectAltTexts(payload.bodyApproved, payload.bodyImageAlts);

  // ── Step 1: Write content + author ──────────────────────────────────────────
  // CRITICAL: Include author to preserve original. NEVER include status/date/slug.
  const contentPayload: Record<string, unknown> = {
    content: bodyWithImages,
    author: parseInt(payload.authorIdCms, 10) || payload.authorIdCms,
    // Note: title is intentionally omitted — the rewrite does not change the title
    // status, date_gmt, slug are intentionally omitted — omitting preserves existing values
  };

  let contentRes: Response;
  try {
    contentRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(contentPayload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      throw new PostBackException(
        "site_unreachable",
        "The connection to your WordPress site timed out. Please check the site is online and try again."
      );
    }
    throw new PostBackException(
      "site_unreachable",
      "Could not reach your WordPress site. Please check it is online and try again."
    );
  }

  if (contentRes.status === 401) {
    throw new PostBackException(
      "connection_lost",
      "We could not connect to your WordPress site. Your credentials may have changed — please reconnect your CMS."
    );
  }
  if (contentRes.status === 403) {
    throw new PostBackException(
      "insufficient_permissions",
      "iAudit does not have permission to update posts in your CMS. Please check your API credentials have write access."
    );
  }
  if (contentRes.status === 404) {
    throw new PostBackException(
      "post_not_found",
      "This post no longer exists in your CMS — it may have been deleted. Would you like to export it instead?"
    );
  }
  if (!contentRes.ok) {
    const body = await contentRes.text().catch(() => "");
    throw new PostBackException(
      "unknown",
      `WordPress returned an unexpected error (HTTP ${contentRes.status}). ${body.slice(0, 200)}`
    );
  }

  // ── Step 2: Write meta title + meta description (Yoast / RankMath) ──────────
  // Attempt meta update separately — if it fails, we report a partial failure
  // rather than rolling back the content write.
  const metaPayload: Record<string, unknown> = {
    meta: {
      // Yoast SEO meta fields
      _yoast_wpseo_title: payload.metaTitle,
      _yoast_wpseo_metadesc: payload.metaDescription,
      // RankMath meta fields (fallback)
      rank_math_title: payload.metaTitle,
      rank_math_description: payload.metaDescription,
    },
  };

  let metaWritten = false;
  try {
    const metaRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metaPayload),
      signal: AbortSignal.timeout(15_000),
    });
    metaWritten = metaRes.ok;
  } catch {
    metaWritten = false;
  }

  if (!metaWritten) {
    // Partial failure — content was written but meta could not be updated
    throw new PostBackException(
      "partial_failure",
      "Post body updated successfully, but meta title and meta description could not be written. Please update them manually.",
      {
        contentWritten: true,
        metaTitle: payload.metaTitle,
        metaDescription: payload.metaDescription,
      }
    );
  }

  // ── Step 3: Attempt schema injection ────────────────────────────────────────
  let schemaInjected = false;
  let schemaFallbackJson: string | null = null;

  if (payload.schemaJson) {
    schemaInjected = await attemptSchemaInjection(
      baseUrl,
      authHeader,
      payload.cmsPostId,
      payload.schemaJson
    );

    if (!schemaInjected) {
      // Build the copyable JSON-LD fallback — guard against malformed stored strings
      try {
        const schemaObj = typeof payload.schemaJson === "string"
          ? JSON.parse(payload.schemaJson)
          : payload.schemaJson;
        // Wrap in a <script> tag for easy copy-paste into theme header / SEO plugin
        const scriptBlock = `<script type="application/ld+json">\n${JSON.stringify(schemaObj, null, 2)}\n</script>`;
        schemaFallbackJson = scriptBlock;
      } catch {
        // schemaJson was unparseable — skip fallback display, post-back still succeeded
        schemaFallbackJson = null;
      }
    }
  }

  return {
    success: true,
    schemaInjected,
    schemaFallbackJson,
  };
}
