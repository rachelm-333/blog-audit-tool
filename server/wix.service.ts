/**
 * iAudit — Wix Blog API Integration (Layer 13 / Section 16.2)
 *
 * Auth: wix-api-key + wix-site-id headers
 * Base URL: https://www.wixapis.com/blog/v3/
 *
 * Import: GET /blog/v3/posts (with SEO data)
 * Post-back: PATCH /blog/v3/draft-posts/{id} — richContent + seoData only
 * Schema: NEVER auto-inject via Wix API — always show copyable JSON-LD block
 *
 * Status mapping:
 *   PUBLISHED  → published
 *   SCHEDULED  → scheduled
 *   DRAFT      → draft
 *   (DELETED is never imported)
 */

import { JSDOM } from "jsdom";
import type { WixCredentials } from "./encryption.service";
import { extractBodyImageAlts } from "./wordpress.service";
import type { WpImportedPost, WpPostStatus } from "./wordpress.service";
import { PostBackException, preserveImagesInBody } from "./postback.service";
import { extractKeywordFromTitle, validateKeyword } from "./keyword.service";

// ─── Constants ────────────────────────────────────────────────────────────────

const WIX_BASE = "https://www.wixapis.com/blog/v3";

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
  // Wix Blog API v3 requires the raw API key in Authorization — NO "Bearer" prefix.
  // See: https://dev.wix.com/docs/api-reference/articles/authentication/api-keys/make-api-calls-with-an-api-key
  //
  // IMPORTANT: Do NOT send Content-Type on GET requests. Wix v3 interprets any
  // Content-Type header as a signal that there is a request body and attempts to
  // deserialise it, throwing "Failed to parse JSON or deserialize protobuf message".
  return {
    "Authorization": creds.apiKey,
    "wix-site-id": creds.siteId,
    "Accept": "application/json",
  };
}

async function wixFetch(
  url: string,
  creds: WixCredentials,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...buildHeaders(creds),
      ...(options.headers as Record<string, string> | undefined ?? {}),
    },
  });
}

// ─── HTML → Ricos converter ───────────────────────────────────────────────────

let _nodeIdCounter = 0;
function genId(): string {
  _nodeIdCounter = (_nodeIdCounter + 1) % 1_000_000;
  return `n${Date.now().toString(36)}${_nodeIdCounter.toString(36)}`;
}

/**
 * Convert an HTML string to a Wix Ricos richContent document.
 * Supports: h1-h6, p, ul, ol, li, strong/b, em/i, a, br, img.
 * Non-text nodes (images from original body) are preserved as IMAGE nodes.
 */
function htmlToRicos(html: string): object {
  const { window } = new JSDOM(`<body>${html}</body>`);
  const doc = window.document;
  const body = doc.body;

  const nodes: object[] = [];

  function textDecorations(el: Element): object[] {
    const decs: object[] = [];
    const tag = el.tagName?.toLowerCase();
    if (tag === "strong" || tag === "b") decs.push({ type: "BOLD" });
    if (tag === "em" || tag === "i") decs.push({ type: "ITALIC" });
    if (tag === "u") decs.push({ type: "UNDERLINE" });
    if (tag === "a") {
      const href = (el as HTMLAnchorElement).href;
      if (href && href !== "about:blank") {
        // Wix richContent target must be a numeric enum: 0=SELF, 1=BLANK, 2=PARENT, 3=TOP
        const targetAttr = (el as HTMLAnchorElement).target;
        let wixTarget: number;
        if (targetAttr === "_self" || targetAttr === "SELF" || targetAttr === "0") {
          wixTarget = 0;
        } else if (targetAttr === "_parent" || targetAttr === "PARENT" || targetAttr === "2") {
          wixTarget = 2;
        } else if (targetAttr === "_top" || targetAttr === "TOP" || targetAttr === "3") {
          wixTarget = 3;
        } else {
          // Default to BLANK (1) for _blank, empty, or any unrecognised value
          wixTarget = 1;
        }
        decs.push({ type: "LINK", linkData: { link: { url: href, target: wixTarget } } });
      }
    }
    return decs;
  }

  function collectTextNodes(node: Node, parentDecs: object[] = []): object[] {
    const result: object[] = [];
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        const text = child.textContent ?? "";
        if (text) {
          result.push({
            type: "TEXT",
            id: "",
            textData: {
              text,
              decorations: parentDecs.length ? parentDecs : [],
            },
          });
        }
      } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === "br") {
          result.push({ type: "TEXT", id: "", textData: { text: "\n", decorations: [] } });
        } else if (tag === "img") {
          // images inside paragraphs — skip here, handled at block level
        } else {
          const decs = [...parentDecs, ...textDecorations(el)];
          result.push(...collectTextNodes(el, decs));
        }
      }
    });
    return result;
  }

  function processBlock(el: Element): void {
    const tag = el.tagName.toLowerCase();

    if (tag === "img") {
      const src = (el as HTMLImageElement).src;
      const alt = (el as HTMLImageElement).alt ?? "";
      if (src && src !== "about:blank") {
        nodes.push({
          type: "IMAGE",
          id: genId(),
          nodes: [],
          imageData: {
            containerData: { width: { size: "CONTENT" }, alignment: "CENTER", textWrap: false },
            image: { src: { url: src }, altText: alt },
          },
        });
      }
      return;
    }

    if (tag.match(/^h[1-6]$/)) {
      const level = parseInt(tag[1]);
      const textNodes = collectTextNodes(el);
      if (textNodes.length === 0) return;
      nodes.push({
        type: "HEADING",
        id: genId(),
        nodes: textNodes,
        headingData: { level, textStyle: { textAlignment: "AUTO" } },
      });
      return;
    }

    if (tag === "p") {
      // Check for img children — emit as IMAGE nodes
      el.querySelectorAll("img").forEach((img) => {
        const src = img.src;
        const alt = img.alt ?? "";
        if (src && src !== "about:blank") {
          nodes.push({
            type: "IMAGE",
            id: genId(),
            nodes: [],
            imageData: {
              containerData: { width: { size: "CONTENT" }, alignment: "CENTER", textWrap: false },
              image: { src: { url: src }, altText: alt },
            },
          });
        }
        img.remove();
      });
      const textNodes = collectTextNodes(el);
      if (textNodes.length === 0) {
        // empty paragraph — emit empty paragraph as spacer
        nodes.push({
          type: "PARAGRAPH",
          id: genId(),
          nodes: [],
          paragraphData: { textStyle: { textAlignment: "AUTO" } },
        });
        return;
      }
      nodes.push({
        type: "PARAGRAPH",
        id: genId(),
        nodes: textNodes,
        paragraphData: { textStyle: { textAlignment: "AUTO" } },
      });
      return;
    }

    if (tag === "ul" || tag === "ol") {
      const listType = tag === "ul" ? "BULLETED_LIST" : "ORDERED_LIST";
      const listItems: object[] = [];
      el.querySelectorAll(":scope > li").forEach((li) => {
        const textNodes = collectTextNodes(li);
        listItems.push({
          type: "LIST_ITEM",
          id: genId(),
          nodes: [
            {
              type: "PARAGRAPH",
              id: genId(),
              nodes: textNodes,
              paragraphData: { textStyle: { textAlignment: "AUTO" } },
            },
          ],
        });
      });
      if (listItems.length > 0) {
        nodes.push({ type: listType, id: genId(), nodes: listItems });
      }
      return;
    }

    if (tag === "blockquote") {
      const textNodes = collectTextNodes(el);
      if (textNodes.length > 0) {
        nodes.push({
          type: "BLOCKQUOTE",
          id: genId(),
          nodes: [
            {
              type: "PARAGRAPH",
              id: genId(),
              nodes: textNodes,
              paragraphData: { textStyle: { textAlignment: "AUTO" } },
            },
          ],
        });
      }
      return;
    }

    // Fallback: treat as paragraph
    const textNodes = collectTextNodes(el);
    if (textNodes.length > 0) {
      nodes.push({
        type: "PARAGRAPH",
        id: genId(),
        nodes: textNodes,
        paragraphData: { textStyle: { textAlignment: "AUTO" } },
      });
    }
  }

  body.childNodes.forEach((child) => {
    if (child.nodeType === 1) {
      const before = nodes.length;
      processBlock(child as Element);
      // If a new block was added, insert ONE empty paragraph spacer before it
      // (except before the very first block, and only if the previous node is not already an empty PARAGRAPH)
      if (nodes.length > before && before > 0) {
        const prevNode = nodes[before - 1] as any;
        const prevIsEmptyParagraph =
          prevNode?.type === "PARAGRAPH" &&
          Array.isArray(prevNode?.nodes) &&
          prevNode.nodes.length === 0;
        if (!prevIsEmptyParagraph) {
          nodes.splice(before, 0, {
            type: "PARAGRAPH",
            id: genId(),
            nodes: [],
            paragraphData: { textStyle: { textAlignment: "AUTO" } },
          });
        }
      }
    } else if (child.nodeType === 3) {
      const text = child.textContent?.trim();
      if (text) {
        nodes.push({
          type: "PARAGRAPH",
          id: genId(),
          nodes: [{ type: "TEXT", id: "", textData: { text, decorations: [] } }],
          paragraphData: { textStyle: { textAlignment: "AUTO" } },
        });
      }
    }
  });

  // Ensure document ends with an empty paragraph (Wix requirement)
  if (nodes.length === 0 || (nodes[nodes.length - 1] as any).type !== "PARAGRAPH") {
    nodes.push({
      type: "PARAGRAPH",
      id: genId(),
      nodes: [],
      paragraphData: { textStyle: { textAlignment: "AUTO" } },
    });
  }

  return { nodes };
}

// ─── Import helpers ───────────────────────────────────────────────────────────

function parseWixPost(raw: Record<string, unknown>): WpImportedPost {
  const cmsPostId = raw.id as string;
  const title = (raw.title as string) ?? "";
  const status = WIX_STATUS_MAP[(raw.status as string) ?? ""] ?? "draft";
  const urlRaw = raw.url as Record<string, string> | undefined;
  const urlBase = urlRaw?.base ?? "";
  const urlPath = urlRaw?.path ?? "";
  // Build the full URL: prefer base+path combo, fall back to whichever is present
  const fullUrl = urlBase && urlPath
    ? `${urlBase.replace(/\/$/, "")}${urlPath}`
    : urlBase || urlPath;
  const dateRaw = (raw.firstPublishedDate ?? raw.createdDate) as string | undefined;
  const publishDate = dateRaw ? new Date(dateRaw) : null;

  // Extract HTML body from richContent nodes
  let bodyHtml = "";
  const rc = raw.richContent as Record<string, unknown> | undefined;
  if (rc?.nodes) {
    bodyHtml = ricosToHtml(rc.nodes as object[]);
  }

  // SEO data
  const seo = raw.seoData as Record<string, unknown> | undefined;
  let metaTitle: string | null = null;
  let metaDescription: string | null = null;
  if (seo?.tags && Array.isArray(seo.tags)) {
    for (const tag of seo.tags as Record<string, unknown>[]) {
      if (tag.type === "title") metaTitle = (tag.children as string) ?? null;
      if (tag.type === "meta" && (tag.props as Record<string, string>)?.name === "description") {
        metaDescription = (tag.props as Record<string, string>).content ?? null;
      }
    }
  }

  const bodyImageAlts = extractBodyImageAlts(bodyHtml);

  // ── Keyword detection with priority-order sources and shared validateKeyword ──
  // Uses the centralised validateKeyword from keyword.service (2–5 words, not all stop words).

  function extractFromSlug(slug: string): string | null {
    // Strip common URL prefixes and split on hyphens/slashes
    const words = slug
      .replace(/^\/|\/$|^blog\/|^posts\//g, "")
      .split(/[-/]+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 1);
    const phrase = words.slice(0, 4).join(" ");
    return validateKeyword(phrase) ? phrase : null;
  }

  // Priority 1: seoData.settings.keywords (Wix SEO app)
  let detectedKeyword: string | null = null;
  const seoSettings = seo?.settings as Record<string, unknown> | undefined;
  const seoKeywordsRaw = seoSettings?.keywords as string | string[] | undefined;
  if (seoKeywordsRaw) {
    // seoKeywordsRaw may be a string, an array of strings, or an array of objects
    // (Wix SEO app stores keywords differently depending on the site config)
    const firstRaw = Array.isArray(seoKeywordsRaw)
      ? seoKeywordsRaw[0]
      : seoKeywordsRaw.split(",")[0];
    // Only call .trim() if the value is actually a string
    const first = typeof firstRaw === "string" ? firstRaw : null;
    const trimmed = first?.trim().toLowerCase() ?? "";
    if (trimmed && validateKeyword(trimmed)) detectedKeyword = trimmed;
  }

  // Priority 2: seoData.tags keyword meta tag
  if (!detectedKeyword && seo?.tags && Array.isArray(seo.tags)) {
    for (const tag of seo.tags as Record<string, unknown>[]) {
      if (tag.type === "meta" && (tag.props as Record<string, string>)?.name === "keywords") {
        const kw = ((tag.props as Record<string, string>).content ?? "").split(",")[0].trim().toLowerCase();
        if (kw && validateKeyword(kw)) { detectedKeyword = kw; break; }
      }
    }
  }

  // Priority 3: URL slug
  if (!detectedKeyword && urlPath) {
    const slugKw = extractFromSlug(urlPath);
    if (slugKw) detectedKeyword = slugKw;
  }
  // Priority 4: extractKeywordFromTitle (title + body + metaTitle + metaDesc — 5-zone scoring)
  if (!detectedKeyword) {
    const titleKw = extractKeywordFromTitle(
      title,
      bodyHtml,
      metaTitle ?? "",
      metaDescription ?? "",
    );
    if (titleKw && validateKeyword(titleKw)) detectedKeyword = titleKw;
  }
  // If still invalid, leave null — user fills manually
  const focusKeyword = detectedKeyword;

  // ── FIX 4: Correctly read published/draft status from Wix API ──
  // The Wix Blog API returns status on the top-level post object.
  // When fetching published posts via /posts endpoint, status is always PUBLISHED.
  // When fetching draft posts via /draft-posts endpoint, status may be DRAFT.
  // WIX_STATUS_MAP already handles this correctly — the bug was that some Wix
  // sites return a nested status inside a `publishingStatus` field.
  const rawStatus = (raw.status as string)
    ?? (raw.publishingStatus as string)
    ?? "";
  const resolvedStatus: WpPostStatus = WIX_STATUS_MAP[rawStatus] ?? "published";

  return {
    cmsPostId,
    title,
    status: resolvedStatus,
    url: fullUrl,
    publishDate,
    scheduledDate: null,
    authorIdCms: "",
    authorNameCms: "",
    focusKeyword,
    metaTitle: metaTitle || title,
    metaDescription,
    featuredImageUrl: null,
    featuredImageAlt: null,
    bodyHtml,
    bodyImageAlts,
    categories: [],
    tags: [],
  };
}

/**
 * Convert Ricos nodes back to HTML for storage and auditing.
 */
function ricosToHtml(nodes: object[]): string {
  let html = "";

  function decorateText(text: string, decs: Record<string, unknown>[]): string {
    let t = text;
    for (const d of decs) {
      if (d.type === "BOLD") t = `<strong>${t}</strong>`;
      else if (d.type === "ITALIC") t = `<em>${t}</em>`;
      else if (d.type === "UNDERLINE") t = `<u>${t}</u>`;
      else if (d.type === "LINK") {
        const url = ((d.linkData as any)?.link?.url) ?? "";
        t = `<a href="${url}">${t}</a>`;
      }
    }
    return t;
  }

  function processTextNodes(children: object[]): string {
    return children
      .map((n: any) => {
        if (n.type === "TEXT") {
          return decorateText(n.textData?.text ?? "", n.textData?.decorations ?? []);
        }
        return "";
      })
      .join("");
  }

  for (const node of nodes as any[]) {
    switch (node.type) {
      case "HEADING": {
        const level = node.headingData?.level ?? 2;
        html += `<h${level}>${processTextNodes(node.nodes ?? [])}</h${level}>`;
        break;
      }
      case "PARAGRAPH": {
        const inner = processTextNodes(node.nodes ?? []);
        html += inner ? `<p>${inner}</p>` : "<p></p>";
        break;
      }
      case "BULLETED_LIST": {
        const items = (node.nodes ?? []).map((li: any) => {
          const inner = (li.nodes ?? []).map((p: any) => processTextNodes(p.nodes ?? [])).join("");
          return `<li>${inner}</li>`;
        });
        html += `<ul>${items.join("")}</ul>`;
        break;
      }
      case "ORDERED_LIST": {
        const items = (node.nodes ?? []).map((li: any) => {
          const inner = (li.nodes ?? []).map((p: any) => processTextNodes(p.nodes ?? [])).join("");
          return `<li>${inner}</li>`;
        });
        html += `<ol>${items.join("")}</ol>`;
        break;
      }
      case "BLOCKQUOTE": {
        const inner = (node.nodes ?? []).map((p: any) => processTextNodes(p.nodes ?? [])).join("");
        html += `<blockquote>${inner}</blockquote>`;
        break;
      }
      case "IMAGE": {
        const src = node.imageData?.image?.src?.url ?? node.imageData?.image?.src?.id ?? "";
        const alt = node.imageData?.image?.altText ?? "";
        if (src) html += `<img src="${src}" alt="${alt}" />`;
        break;
      }
      default:
        break;
    }
  }

  return html;
}

// ─── Import ───────────────────────────────────────────────────────────────────

export async function importFromWix(
  creds: WixCredentials,
  options: { limit?: number; cursor?: string } = {}
): Promise<{ posts: WpImportedPost[]; nextCursor: string | null }> {
  // IMPORTANT: The Wix Blog API v3 does NOT support `fieldsets` as a GET query parameter.
  // Sending fieldsets in the query string causes HTTP 400 "Failed to parse JSON or deserialize
  // protobuf message". The correct approach is to use POST /query with fieldsets in the body.
  const url = `${WIX_BASE}/posts/query`;

  const requestBody: Record<string, unknown> = {
    fieldsets: ["SEO", "RICH_CONTENT"],
    paging: { limit: options.limit ?? 100 },
  };
  if (options.cursor) {
    (requestBody.paging as Record<string, unknown>).cursor = options.cursor;
  }

  // ── Diagnostic logging ──────────────────────────────────────────
  console.log("[Wix Import] POST", url, "body:", JSON.stringify(requestBody));
  console.log("[Wix Import] siteId present:", !!creds.siteId, "| apiKey length:", creds.apiKey?.length ?? 0);

  let res: Response;
  try {
    res = await wixFetch(url, creds, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (err: any) {
    console.error("[Wix Import] Network error:", err?.message);
    throw new WixImportException("site_unreachable", `Could not reach Wix: ${err?.message}`);
  }

  console.log("[Wix Import] Response status:", res.status, res.statusText);

  if (res.status === 401 || res.status === 403) {
    let body = "";
    try { body = await res.text(); } catch {}
    console.error("[Wix Import] Auth failure body:", body.slice(0, 500));
    throw new WixImportException("invalid_credentials", `Invalid Wix API key or insufficient permissions. API response: ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    console.error("[Wix Import] Non-OK response body:", body.slice(0, 500));
    throw new WixImportException("site_unreachable", `Wix API returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const rawPosts = (data.posts ?? []) as Record<string, unknown>[];

  if (rawPosts.length === 0 && !options.cursor) {
    throw new WixImportException("zero_posts", "No posts found on this Wix site.");
  }

  const posts: WpImportedPost[] = [];
  for (const raw of rawPosts) {
    try {
      posts.push(parseWixPost(raw));
    } catch (parseErr: any) {
      // Log the exact error and the raw post that caused it so we can diagnose
      console.error(
        "[Wix Import] parseWixPost failed for post id:",
        raw.id,
        "title:",
        raw.title,
        "error:",
        parseErr?.message,
        parseErr?.stack?.slice(0, 400)
      );
      // Skip this post rather than crashing the entire import
    }
  }
  // POST /query response has two paging objects:
  //   data.metaData.cursor         — flat cursor string (simple paging, no sub-object)
  //   data.pagingMetadata.cursors.next — correct cursor for Query API pagination
  // We must use pagingMetadata.cursors.next; metaData has no .cursors property.
  const nextCursor: string | null =
    (data.pagingMetadata as any)?.cursors?.next ??
    (data.metaData as any)?.cursor ??
    null;

  return { posts, nextCursor };
}

// ─── importWixPosts (wrapper matching WordPress import interface) ────────────

export async function importWixPosts(
  creds: WixCredentials,
  statusFilter: "published" | "scheduled" | "draft" | "all" = "all"
): Promise<{ posts: WpImportedPost[]; errors: string[] }> {
  const allPosts: WpImportedPost[] = [];
  let cursor: string | undefined;

  do {
    const { posts, nextCursor } = await importFromWix(creds, { limit: 100, cursor });
    allPosts.push(...posts);
    cursor = nextCursor ?? undefined;
  } while (cursor);

  const filtered =
    statusFilter === "all"
      ? allPosts
      : allPosts.filter((p) => p.status === statusFilter);

  return { posts: filtered, errors: [] };
}

// ─── Connection test ──────────────────────────────────────────────────────────

export async function testWixConnection(
  creds: WixCredentials
): Promise<{ ok: boolean; message: string; siteId: string }> {
  const url = `${WIX_BASE}/posts?paging.limit=1`;

  // ── Diagnostic logging ──────────────────────────────────────────────────────
  console.log("[Wix Test] URL:", url);
  console.log("[Wix Test] siteId present:", !!creds.siteId, "| apiKey length:", creds.apiKey?.length ?? 0);
  console.log("[Wix Test] Authorization header (raw key, no Bearer):", creds.apiKey?.slice(0, 8) + "...");
  console.log("[Wix Test] wix-site-id:", creds.siteId?.slice(0, 8) + "...");

  let res: Response;
  try {
    res = await wixFetch(url, creds);
  } catch (err: any) {
    console.error("[Wix Test] Network error:", err?.message);
    return { ok: false, message: `Could not reach Wix: ${err?.message}`, siteId: "" };
  }

  console.log("[Wix Test] Response status:", res.status, res.statusText);

  if (res.status === 401 || res.status === 403) {
    let body = "";
    try { body = await res.text(); } catch {}
    console.error("[Wix Test] Auth failure body:", body.slice(0, 500));
    return { ok: false, message: `Invalid Wix API key or insufficient permissions. API: ${body.slice(0, 200)}`, siteId: "" };
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    console.error("[Wix Test] Non-OK body:", body.slice(0, 500));
    return { ok: false, message: `Wix API returned HTTP ${res.status}: ${body.slice(0, 200)}`, siteId: "" };
  }
  return { ok: true, message: "", siteId: creds.siteId };
}

// ─── Post-back ────────────────────────────────────────────────────────────────

export interface WixPostBackPayload {
  cmsPostId: string;
  metaTitle: string;
  metaDescription: string;
  bodyApproved: string;
  bodyOriginal?: string | null;
  bodyImageAlts?: string[];
}

export interface WixPostBackResult {
  success: true;
  /** Wix never supports auto-injection — always provide copyable JSON-LD */
  schemaInjected: false;
  schemaFallbackJson: string | null;
}

/**
 * Posts back approved content to a Wix blog post.
 *
 * Wix Blog v3 uses richContent (Ricos JSON), NOT HTML.
 * The correct flow is:
 *   1. Fetch the current draft to extract original IMAGE nodes (preserves Wix-hosted images)
 *   2. Run preserveImagesInBody to re-inject original images into the rewritten HTML
 *   3. Convert the merged HTML body to Ricos richContent
 *   4. PATCH /blog/v3/draft-posts/{id}  — update the draft with richContent + seoData
 *   5. POST  /blog/v3/draft-posts/{id}/publish — re-publish, updating the live post
 *
 * ONLY updates: richContent (body), seoData (meta title + description).
 * NEVER updates: author, date, status, URL/slug, post title.
 * Schema injection is NOT supported by Wix API — always returns schemaFallbackJson.
 */
export async function postBackToWix(
  creds: WixCredentials,
  payload: WixPostBackPayload,
  schemaJson: unknown | null
): Promise<WixPostBackResult> {
  const draftUrl = `${WIX_BASE}/draft-posts/${payload.cmsPostId}`;
  const publishUrl = `${WIX_BASE}/draft-posts/${payload.cmsPostId}/publish`;

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

  // Step 0: Fetch the current draft to get original IMAGE nodes from Wix richContent.
  // This is critical — Wix images are stored as Ricos IMAGE nodes with Wix-internal
  // media IDs (not plain URLs), so we must preserve them from the original draft.
  let originalImageNodes: object[] = [];
  let originalRicosNodeCount = 0;
  try {
    const draftRes = await wixFetch(`${draftUrl}?fieldsets=RICH_CONTENT`, creds);
    if (draftRes.ok) {
      const draftData = await draftRes.json() as Record<string, unknown>;
      const draftPost = (draftData.draftPost ?? draftData) as Record<string, unknown>;
      const rc = draftPost.richContent as Record<string, unknown> | undefined;
      if (rc?.nodes && Array.isArray(rc.nodes)) {
        const allNodes = rc.nodes as Record<string, unknown>[];
        originalRicosNodeCount = allNodes.length;
        originalImageNodes = allNodes.filter((n) => n.type === "IMAGE" || n.type === "GALLERY");
      }
    }
  } catch {
    // If we can't fetch the original, proceed without image preservation
    console.warn("[Wix PostBack] Could not fetch original draft for image preservation");
  }

  // Step 1: Re-inject original images into the rewritten HTML at proportional positions
  // using the same strategy as WordPress post-back.
  const altTexts = payload.bodyImageAlts ?? [];
  const bodyWithImages = preserveImagesInBody(
    payload.bodyOriginal ?? "",
    payload.bodyApproved,
    altTexts
  );

  // Step 2: Strip H1 from the body before converting — Wix blog has its own title field;
  // an H1 in the body would appear as a duplicate/wrong title on the live page.
  const bodyWithoutH1 = bodyWithImages.replace(/<h1[^>]*>.*?<\/h1>/gi, "");

  // Step 3: Convert the merged HTML body to Ricos richContent
  const richContentFromHtml = htmlToRicos(bodyWithoutH1) as { nodes: object[] };

  // Step 4: If we have original Wix IMAGE nodes (with Wix media IDs), place them ALL at the
  // top of the post (after the first paragraph). This is safer than guessing proportional
  // positions in a rewritten body — the user can drag images to their preferred location
  // in the Wix editor after publishing.
  let finalNodes: object[] = richContentFromHtml.nodes;
  if (originalImageNodes.length > 0) {
    // Remove any IMAGE nodes that htmlToRicos produced (they came from <img> tags in the
    // original HTML which may have had external URLs — replace with original Wix nodes)
    const textOnlyNodes = richContentFromHtml.nodes.filter(
      (n) => (n as any).type !== "IMAGE" && (n as any).type !== "GALLERY"
    );

    // Find the insertion point: after the first non-empty PARAGRAPH (i.e. after the intro paragraph)
    let insertAfter = 0;
    for (let i = 0; i < textOnlyNodes.length; i++) {
      const n = textOnlyNodes[i] as any;
      if (n.type === "PARAGRAPH" && Array.isArray(n.nodes) && n.nodes.length > 0) {
        insertAfter = i + 1;
        break;
      }
    }

    // Build the final node list: [intro paragraph(s)] + [all images] + [rest of body]
    const before = textOnlyNodes.slice(0, insertAfter);
    const after = textOnlyNodes.slice(insertAfter);
    finalNodes = [...before, ...originalImageNodes, ...after];
  }

  // Ensure document ends with an empty paragraph (Wix requirement)
  if (finalNodes.length === 0 || (finalNodes[finalNodes.length - 1] as any).type !== "PARAGRAPH") {
    const { nanoid } = await import("nanoid");
    finalNodes.push({
      type: "PARAGRAPH",
      id: nanoid(8),
      nodes: [],
      paragraphData: { textStyle: { textAlignment: "AUTO" } },
    });
  }

  // ── Safety gate: never post back if images would be lost ───────────────────
  // If the original draft had images but our final nodes contain zero IMAGE nodes,
  // abort immediately rather than wiping the user's images.
  if (originalImageNodes.length > 0) {
    const finalImageCount = finalNodes.filter(
      (n) => (n as any).type === "IMAGE" || (n as any).type === "GALLERY"
    ).length;
    if (finalImageCount === 0) {
      throw new PostBackException(
        "image_loss_risk",
        `Post-back blocked — your post has ${originalImageNodes.length} image(s) that could not be safely preserved in the rewritten content. No changes have been made to your Wix post. Please contact support or publish manually.`
      );
    }
  }

  const richContent = { nodes: finalNodes };

  // Step 1: Update the draft post with richContent and SEO data
  const patchBody = {
    draftPost: {
      richContent,
      seoData,
    },
    fieldMask: "richContent,seoData",
  };

  let patchRes: Response;
  try {
    patchRes = await wixFetch(draftUrl, creds, {
      method: "PATCH",
      body: JSON.stringify(patchBody),
    });
  } catch (err: any) {
    throw new PostBackException(
      "site_unreachable",
      err?.message ?? "Could not reach your Wix site. Please check it is online and try again."
    );
  }

  if (patchRes.status === 401 || patchRes.status === 403) {
    throw new PostBackException(
      "insufficient_permissions",
      "iAudit does not have permission to update this Wix post. Please check your API key has write access to the Blog."
    );
  }
  if (patchRes.status === 404) {
    throw new PostBackException(
      "post_not_found",
      "This post could not be found in your Wix site. It may have been deleted or the connection may need to be re-synced."
    );
  }
  if (!patchRes.ok) {
    let detail = "";
    try { const b = await patchRes.json(); detail = JSON.stringify(b); } catch {}
    throw new PostBackException(
      "site_unreachable",
      `Could not update the draft post in Wix (HTTP ${patchRes.status}${detail ? ": " + detail : ""}). Please try again.`
    );
  }

  // Step 2: Publish the draft — this updates the live published post
  let publishRes: Response;
  try {
    publishRes = await wixFetch(publishUrl, creds, { method: "POST" });
  } catch (err: any) {
    throw new PostBackException(
      "site_unreachable",
      "Content was updated but could not be published. Please publish manually from your Wix dashboard."
    );
  }

  if (!publishRes.ok) {
    let detail = "";
    try { const b = await publishRes.json(); detail = JSON.stringify(b); } catch {}
    throw new PostBackException(
      "partial_failure",
      `Content was updated but publishing failed (HTTP ${publishRes.status}${detail ? ": " + detail : ""}). Please publish manually from your Wix dashboard.`,
      { contentWritten: true, metaTitle: payload.metaTitle, metaDescription: payload.metaDescription }
    );
  }

  // Schema fallback — Wix never supports auto-injection
  const schemaFallbackJson = schemaJson ? JSON.stringify(schemaJson, null, 2) : null;

  return {
    success: true,
    schemaInjected: false,
    schemaFallbackJson,
  };
}
