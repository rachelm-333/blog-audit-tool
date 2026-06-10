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
import { PostBackException } from "./postback.service";

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
  return {
    "Authorization": `Bearer ${creds.apiKey}`,
    "wix-site-id": creds.siteId,
    "Content-Type": "application/json",
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
        decs.push({ type: "LINK", linkData: { link: { url: href, target: "_BLANK" } } });
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
      processBlock(child as Element);
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
  const urlBase = (raw.url as Record<string, string>)?.base ?? "";
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

  return {
    cmsPostId,
    title,
    status,
    url: urlBase,
    publishDate,
    scheduledDate: null,
    authorIdCms: "",
    authorNameCms: "",
    focusKeyword: null,
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
  const params = new URLSearchParams({
    fieldsets: "SEO,RICH_CONTENT",
    "paging.limit": String(options.limit ?? 100),
  });
  if (options.cursor) params.set("paging.cursor", options.cursor);

  const url = `${WIX_BASE}/posts?${params.toString()}`;
  let res: Response;
  try {
    res = await wixFetch(url, creds);
  } catch (err: any) {
    throw new WixImportException("site_unreachable", `Could not reach Wix: ${err?.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new WixImportException("invalid_credentials", "Invalid Wix API key or insufficient permissions.");
  }
  if (!res.ok) {
    throw new WixImportException("site_unreachable", `Wix API returned HTTP ${res.status}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const rawPosts = (data.posts ?? []) as Record<string, unknown>[];

  if (rawPosts.length === 0 && !options.cursor) {
    throw new WixImportException("zero_posts", "No posts found on this Wix site.");
  }

  const posts = rawPosts.map(parseWixPost);
  const nextCursor = (data.metaData as any)?.cursors?.next ?? null;

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
  let res: Response;
  try {
    res = await wixFetch(url, creds);
  } catch (err: any) {
    return { ok: false, message: `Could not reach Wix: ${err?.message}`, siteId: "" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, message: "Invalid Wix API key or insufficient permissions.", siteId: "" };
  }
  if (!res.ok) {
    return { ok: false, message: `Wix API returned HTTP ${res.status}`, siteId: "" };
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
 *   1. Convert HTML body to Ricos richContent document
 *   2. PATCH /blog/v3/draft-posts/{id}  — update the draft with richContent + seoData
 *   3. POST  /blog/v3/draft-posts/{id}/publish — re-publish, updating the live post
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

  // Convert HTML body to Ricos richContent
  // Images from the original body are preserved because htmlToRicos handles <img> tags,
  // and the bodyApproved HTML already has images re-injected by preserveImagesInBody.
  const richContent = htmlToRicos(payload.bodyApproved);

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
