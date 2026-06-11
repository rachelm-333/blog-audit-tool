/**
 * iAudit — Zapier / Generic Webhook Integration (Layer 13 / Section 16.4)
 *
 * Inbound: POST /api/zapier/inbound/:token
 *   - Receives a blog post payload from any platform via Zapier
 *   - Token is stored in the connection credentials (zapierInboundToken)
 *   - Payload is mapped to the standard post schema and upserted
 *
 * Outbound: POST to zapierOutboundUrl
 *   - Sends approved rewrite data back to the user's Zapier Zap
 *   - Payload: { post_id, title, body_approved, meta_title, meta_description, score_after }
 *
 * No CMS-native API calls — Zapier acts as the bridge.
 * Schema injection: NOT supported — always show copyable JSON-LD block.
 */

import type { ZapierCredentials } from "./encryption.service";
import { extractBodyImageAlts } from "./wordpress.service";
import type { WpImportedPost } from "./wordpress.service";

// ─── Inbound payload schema ───────────────────────────────────────────────────

/**
 * Expected shape of a Zapier inbound webhook payload.
 * All fields are optional except id and title.
 */
export interface ZapierInboundPayload {
  /** CMS post ID (required) */
  id: string;
  /** Post title (required) */
  title: string;
  /** HTML body content */
  body_html?: string;
  /** Plain text body (fallback if body_html not provided) */
  body_text?: string;
  /** Canonical URL of the post */
  url?: string;
  /** Post status: published | scheduled | draft */
  status?: string;
  /** ISO 8601 publish date */
  published_at?: string;
  /** ISO 8601 scheduled date */
  scheduled_at?: string;
  /** Author identifier */
  author_id?: string;
  /** Author display name */
  author_name?: string;
  /** Focus keyword */
  focus_keyword?: string;
  /** SEO meta title */
  meta_title?: string;
  /** SEO meta description */
  meta_description?: string;
  /** Featured image URL */
  featured_image_url?: string;
  /** Featured image alt text */
  featured_image_alt?: string;
  /** Comma-separated categories */
  categories?: string;
  /** Comma-separated tags */
  tags?: string;
}

// ─── Inbound processing ───────────────────────────────────────────────────────

/**
 * Validates and maps a Zapier inbound payload to the standard post format.
 * Returns null if the payload is invalid (missing id or title).
 */
export function mapZapierPayloadToPost(
  payload: ZapierInboundPayload
): WpImportedPost | null {
  if (!payload.id || !payload.title) return null;

  // Status mapping
  const rawStatus = (payload.status ?? "draft").toLowerCase();
  const mappedStatus =
    rawStatus === "published" || rawStatus === "publish"
      ? "published"
      : rawStatus === "scheduled" || rawStatus === "future"
      ? "scheduled"
      : "draft";

  // Dates
  const publishDate =
    mappedStatus === "published" && payload.published_at
      ? new Date(payload.published_at)
      : null;
  const scheduledDate =
    mappedStatus === "scheduled" && payload.scheduled_at
      ? new Date(payload.scheduled_at)
      : null;

  // Body
  const bodyHtml = payload.body_html ?? (payload.body_text ? `<p>${payload.body_text.replace(/\n/g, "</p><p>")}</p>` : "");
  const bodyImageAlts = extractBodyImageAlts(bodyHtml);

  // Categories and tags
  const categories = payload.categories
    ? payload.categories.split(",").map((c) => c.trim()).filter(Boolean)
    : [];
  const tags = payload.tags
    ? payload.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return {
    cmsPostId: payload.id,
    title: payload.title,
    bodyHtml,
    url: payload.url ?? "",
    status: mappedStatus,
    publishDate,
    scheduledDate,
    authorIdCms: payload.author_id ?? "",
    authorNameCms: payload.author_name ?? "Unknown",
    focusKeyword: payload.focus_keyword ?? null,
    metaTitle: payload.meta_title ?? null,
    metaDescription: payload.meta_description ?? null,
    featuredImageUrl: payload.featured_image_url ?? null,
    featuredImageAlt: payload.featured_image_alt ?? null,
    bodyImageAlts,
    categories,
    tags,
  };
}

// ─── Token validation ─────────────────────────────────────────────────────────

/**
 * Generates a secure random inbound token for a Zapier connection.
 */
export function generateZapierToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 48; i++) {
    token += chars[Math.floor(Math.random() * chars.length)];
  }
  return token;
}

// ─── Outbound post-back ───────────────────────────────────────────────────────

export interface ZapierPostBackPayload {
  postId: string;
  title: string;
  bodyApproved: string;
  /** Original body HTML — used to preserve images at top of post before sending */
  bodyOriginal: string | null;
  /** Updated alt texts for images in the body */
  bodyImageAlts: string[];
  metaTitle: string;
  metaDescription: string;
  scoreAfter: number;
  gradeAfter: string;
  postUrl: string;
}

export interface ZapierPostBackResult {
  success: true;
  schemaInjected: false;
  schemaFallbackJson: string | null;
}

/**
 * Sends approved rewrite data to the user's Zapier outbound webhook.
 * Zapier receives the payload and routes it to the target CMS.
 *
 * Images are preserved at the top of the post (after the first paragraph)
 * using the same strategy as WordPress and Shopify post-back.
 */
export async function postBackViaZapier(
  creds: ZapierCredentials,
  payload: ZapierPostBackPayload,
  schemaJson: unknown | null
): Promise<ZapierPostBackResult> {
  if (!creds.outboundWebhookUrl) {
    throw new Error("no_outbound_url");
  }

  // Preserve original images at the top of the post before sending
  const { preserveImagesInBody } = await import("./postback.service");
  const bodyWithImages = payload.bodyOriginal
    ? preserveImagesInBody(payload.bodyOriginal, payload.bodyApproved, payload.bodyImageAlts)
    : payload.bodyApproved;

  const body = {
    post_id: payload.postId,
    title: payload.title,
    body_approved: bodyWithImages,
    meta_title: payload.metaTitle,
    meta_description: payload.metaDescription,
    score_after: payload.scoreAfter,
    grade_after: payload.gradeAfter,
    post_url: payload.postUrl,
    schema_json: schemaJson ? JSON.stringify(schemaJson) : null,
  };

  let res: Response;
  try {
    res = await fetch(creds.outboundWebhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") {
      throw new Error("site_unreachable");
    }
    throw new Error("site_unreachable");
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("insufficient_permissions");
  }
  if (res.status === 404) {
    throw new Error("post_not_found");
  }
  if (!res.ok) {
    throw new Error(`site_unreachable:HTTP ${res.status}`);
  }

  // Schema is always a fallback for Zapier (no native injection)
  const schemaFallbackJson = schemaJson ? JSON.stringify(schemaJson, null, 2) : null;

  return {
    success: true,
    schemaInjected: false,
    schemaFallbackJson,
  };
}
