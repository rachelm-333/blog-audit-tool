/**
 * Layer 13 — Wix, Shopify, and Zapier CMS Integration Tests
 *
 * Tests:
 *   wix.service — testWixConnection:
 *   1.  Returns { ok: true } for a valid Wix API key + siteId (mocked)
 *   2.  Returns { ok: false, errorCode: 'invalid_credentials' } for 401
 *   3.  Returns { ok: false, errorCode: 'site_unreachable' } for network error
 *
 *   wix.service — importWixPosts:
 *   4.  Returns normalised posts array from mocked Wix Blog API response
 *   5.  Filters by status correctly (published only)
 *   6.  Returns empty array when no posts match filter
 *
 *   wix.service — postBackToWix:
 *   7.  Sends PATCH to Wix Blog API with correct payload
 *   8.  Throws PostBackException(connection_lost) on 401
 *   9.  Throws PostBackException(post_not_found) on 404
 *
 *   shopify.service — testShopifyConnection:
 *   10. Returns { ok: true } for a valid Shopify token (mocked)
 *   11. Returns { ok: false, errorCode: 'invalid_credentials' } for 401
 *   12. Returns { ok: false, errorCode: 'site_unreachable' } for network error
 *
 *   shopify.service — importShopifyPosts:
 *   13. Returns normalised posts from mocked Shopify Admin API response
 *   14. Maps Shopify article fields to iAudit post fields correctly
 *
 *   shopify.service — postBackToShopify:
 *   15. Sends PUT to Shopify Admin API with correct article payload
 *   16. Throws PostBackException(post_not_found) on 404
 *
 *   zapier.service — sendZapierPostBack:
 *   17. POSTs correct payload to outbound webhook URL
 *   18. Throws PostBackException(site_unreachable) on network error
 *   19. Resolves successfully when outbound URL returns 200
 *
 *   tRPC — cms.connectWix:
 *   20. Creates a new Wix connection and returns connectionId
 *   21. Returns FORBIDDEN when businessId belongs to another user
 *
 *   tRPC — cms.connectShopify:
 *   22. Creates a new Shopify connection and returns connectionId
 *
 *   tRPC — cms.connectZapier:
 *   23. Creates a new Zapier connection and returns connectionId + inboundUrl
 *   24. Returns inboundUrl containing the webhookSecret
 *
 *   tRPC — postback.runPostBack (Wix):
 *   25. Dispatches to postBackToWix for wix platform connections
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { createIauditUser } from "./iauth.db";
import { getDb } from "./db";
import {
  iauditUsers,
  businesses,
  posts,
  cmsConnections,
} from "../drizzle/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(iauditUserId: string) {
  return appRouter.createCaller({
    user: null,
    req: {} as never,
    res: {} as never,
    iauditUserId,
  });
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

let testUserId: string;
let otherUserId: string;
let businessId: string;
let otherBusinessId: string;
let wixConnectionId: string;
let shopifyConnectionId: string;
let zapierConnectionId: string;
let wixPostId: string;

beforeAll(async () => {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  testUserId = nanoid();
  otherUserId = nanoid();

  await createIauditUser({
    id: testUserId,
    email: `layer13-test-${testUserId}@test.com`,
    name: "Layer 13 Test User",
    passwordHash: "hash",
    accountType: "solo",
    emailVerified: true,
  });

  await createIauditUser({
    id: otherUserId,
    email: `layer13-other-${otherUserId}@test.com`,
    name: "Layer 13 Other User",
    passwordHash: "hash",
    accountType: "solo",
    emailVerified: true,
  });

  // Set credits
  await db
    .update(iauditUsers)
    .set({ creditsRemaining: 5 })
    .where(eq(iauditUsers.id, testUserId));

  // Create businesses
  businessId = nanoid();
  await db.insert(businesses).values({
    id: businessId,
    userId: testUserId,
    businessName: "Layer 13 Test Business",
    websiteUrl: "https://layer13-test.example.com",
    industry: "home_services",
    location: "Sydney, NSW",
    brandVoice: "Professional",
    tone: "Friendly",
    targetAudience: "Homeowners",
    uvp: "We deliver results",
    services: ["SEO"],
    primaryCtaUrl: "https://layer13-test.example.com/contact",
    primaryCtaLabel: "Contact Us",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  otherBusinessId = nanoid();
  await db.insert(businesses).values({
    id: otherBusinessId,
    userId: otherUserId,
    businessName: "Layer 13 Other Business",
    websiteUrl: "https://layer13-other.example.com",
    industry: "home_services",
    location: "Melbourne, VIC",
    brandVoice: "Professional",
    tone: "Friendly",
    targetAudience: "Homeowners",
    uvp: "We deliver results",
    services: ["SEO"],
    primaryCtaUrl: "https://layer13-other.example.com/contact",
    primaryCtaLabel: "Contact Us",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  // Create a Wix connection for postback tests
  wixConnectionId = nanoid();
  await db.insert(cmsConnections).values({
    id: wixConnectionId,
    businessId,
    platform: "wix",
    siteUrl: "https://www.wix.com",
    credentialsEncrypted: JSON.stringify({
      siteId: "test-site-id",
      apiKey: "test-api-key",
    }),
    connectionStatus: "connected",
  });

  // Create a Shopify connection
  shopifyConnectionId = nanoid();
  await db.insert(cmsConnections).values({
    id: shopifyConnectionId,
    businessId,
    platform: "shopify",
    siteUrl: "https://test-store.myshopify.com",
    credentialsEncrypted: JSON.stringify({
      shop: "test-store.myshopify.com",
      accessToken: "shpat_test",
    }),
    connectionStatus: "connected",
  });

  // Create a Zapier connection
  zapierConnectionId = nanoid();
  await db.insert(cmsConnections).values({
    id: zapierConnectionId,
    businessId,
    platform: "zapier",
    siteUrl: "https://zapier.com",
    credentialsEncrypted: JSON.stringify({
      webhookSecret: "test-secret-abc123",
      outboundWebhookUrl: "https://hooks.zapier.com/hooks/catch/test",
    }),
    connectionStatus: "connected",
  });

  // Create a Wix post for postback tests
  wixPostId = nanoid();
  await db.insert(posts).values({
    id: wixPostId,
    businessId,
    cmsConnectionId: wixConnectionId,
    cmsPostId: "wix-post-abc123",
    cmsPlatform: "wix",
    title: "Wix Test Post",
    bodyOriginal: "<p>Original content</p>",
    bodyApproved: "<p>Approved rewritten content</p>",
    url: "https://www.wix.com/blog/wix-test-post",
    status: "published",
    authorIdCms: "wix-author-1",
    authorNameCms: "Wix Author",
    auditScore: 8,
    rewriteScore: 14,
    rewriteGrade: "Optimised",
    metaTitleApproved: "Wix Test Post | Optimised",
    metaDescriptionApproved: "This is the optimised meta description for the Wix test post.",
    postBackStatus: "pending",
  });
});

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  await db.delete(posts).where(eq(posts.businessId, businessId));
  await db.delete(cmsConnections).where(eq(cmsConnections.businessId, businessId));
  await db.delete(cmsConnections).where(eq(cmsConnections.businessId, otherBusinessId));
  await db.delete(businesses).where(eq(businesses.id, businessId));
  await db.delete(businesses).where(eq(businesses.id, otherBusinessId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, testUserId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, otherUserId));
});

// ---------------------------------------------------------------------------
// wix.service — testWixConnection
// ---------------------------------------------------------------------------

describe("wix.service — testWixConnection", () => {
  it("1. Returns { ok: true } for a valid Wix API key + siteId (mocked)", async () => {
    const { testWixConnection } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ posts: [] }),
    } as Response);

    const result = await testWixConnection({ siteId: "test-site", apiKey: "test-key" });
    expect(result.ok).toBe(true);
    fetchSpy.mockRestore();
  });

  it("2. Returns { ok: false, errorCode: 'invalid_credentials' } for 401", async () => {
    const { testWixConnection } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: "Unauthorized" }),
    } as Response);

    const result = await testWixConnection({ siteId: "test-site", apiKey: "bad-key" });
    expect(result.ok).toBe(false);
    expect((result as any).errorCode).toBe("invalid_credentials");
    fetchSpy.mockRestore();
  });

  it("3. Returns { ok: false, errorCode: 'site_unreachable' } for network error", async () => {
    const { testWixConnection } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await testWixConnection({ siteId: "test-site", apiKey: "test-key" });
    expect(result.ok).toBe(false);
    expect((result as any).errorCode).toBe("site_unreachable");
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// wix.service — importWixPosts
// ---------------------------------------------------------------------------

describe("wix.service — importWixPosts", () => {
  it("4. Returns normalised posts array from mocked Wix Blog API response", async () => {
    const { importWixPosts } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        posts: [
          {
            id: "wix-1",
            title: "My Wix Post",
            content: "<p>Hello world</p>",
            url: "/blog/my-wix-post",
            status: "PUBLISHED",
            author: { id: "author-1", name: "Jane" },
            publishedDate: "2024-01-01T00:00:00Z",
          },
        ],
        metaData: { count: 1, total: 1 },
      }),
    } as Response);

    const result = await importWixPosts(
      { siteId: "test-site", apiKey: "test-key" },
      "all"
    );
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].title).toBe("My Wix Post");
    expect(result.posts[0].cmsPostId).toBe("wix-1");
    fetchSpy.mockRestore();
  });

  it("5. Filters by status correctly (published only)", async () => {
    const { importWixPosts } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        posts: [
          { id: "wix-pub", title: "Published", content: "<p>pub</p>", url: "/blog/pub", status: "PUBLISHED", author: { id: "a1", name: "Author" }, publishedDate: "2024-01-01T00:00:00Z" },
          { id: "wix-draft", title: "Draft", content: "<p>draft</p>", url: "/blog/draft", status: "DRAFT", author: { id: "a1", name: "Author" }, publishedDate: null },
        ],
        metaData: { count: 2, total: 2 },
      }),
    } as Response);

    const result = await importWixPosts(
      { siteId: "test-site", apiKey: "test-key" },
      "published"
    );
    expect(result.posts.every((p) => p.status === "published")).toBe(true);
    fetchSpy.mockRestore();
  });

  it("6. Returns empty array when no posts match filter", async () => {
    const { importWixPosts } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ posts: [], metaData: { count: 0, total: 0 } }),
    } as Response);

    const result = await importWixPosts(
      { siteId: "test-site", apiKey: "test-key" },
      "scheduled"
    );
    expect(result.posts).toHaveLength(0);
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// wix.service — postBackToWix
// ---------------------------------------------------------------------------

describe("wix.service — postBackToWix", () => {
  it("7. Sends PATCH to Wix Blog API with correct payload", async () => {
    const { postBackToWix } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ post: { id: "wix-1", url: "https://www.wix.com/blog/test" } }),
    } as Response);

    const result = await postBackToWix(
      { siteId: "test-site", apiKey: "test-key" },
      {
        cmsPostId: "wix-1",
        bodyApproved: "<p>New content</p>",
        metaTitleApproved: "New Title",
        metaDescriptionApproved: "New description",
        imageAltTexts: [],
        authorIdCms: "author-1",
      },
      null
    );
    expect(result.schemaInjected).toBeDefined();
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

    it("8. Throws Error(insufficient_permissions) on 401", async () => {
    const { postBackToWix } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: "Unauthorized" }),
    } as Response);
    await expect(
      postBackToWix(
        { siteId: "test-site", apiKey: "bad-key" },
        { cmsPostId: "wix-1", bodyApproved: "<p>x</p>", metaTitleApproved: "T", metaDescriptionApproved: "D", imageAltTexts: [], authorIdCms: "a1" },
        null
      )
    ).rejects.toThrow("insufficient_permissions");
    fetchSpy.mockRestore();
  });
  it("9. Throws Error(post_not_found) on 404", async () => {
    const { postBackToWix } = await import("./wix.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    } as Response);
    let thrown: any;
    try {
      await postBackToWix(
        { siteId: "test-site", apiKey: "test-key" },
        { cmsPostId: "wix-missing", bodyApproved: "<p>x</p>", metaTitleApproved: "T", metaDescriptionApproved: "D", imageAltTexts: [], authorIdCms: "a1" },
        null
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe("post_not_found");
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// shopify.service — testShopifyConnection
// ---------------------------------------------------------------------------

describe("shopify.service — testShopifyConnection", () => {
  it("10. Returns { ok: true } for a valid Shopify token (mocked)", async () => {
    const { testShopifyConnection } = await import("./shopify.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ blogs: [] }),
    } as Response);

    const result = await testShopifyConnection({ shop: "test.myshopify.com", accessToken: "shpat_test" });
    expect(result.ok).toBe(true);
    fetchSpy.mockRestore();
  });

  it("11. Returns { ok: false, errorCode: 'invalid_credentials' } for 401", async () => {
    const { testShopifyConnection } = await import("./shopify.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ errors: "Unauthorized" }),
    } as Response);

    const result = await testShopifyConnection({ shop: "test.myshopify.com", accessToken: "bad-token" });
    expect(result.ok).toBe(false);
    expect((result as any).errorCode).toBe("invalid_credentials");
    fetchSpy.mockRestore();
  });

  it("12. Returns { ok: false, errorCode: 'site_unreachable' } for network error", async () => {
    const { testShopifyConnection } = await import("./shopify.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await testShopifyConnection({ shop: "test.myshopify.com", accessToken: "shpat_test" });
    expect(result.ok).toBe(false);
    expect((result as any).errorCode).toBe("site_unreachable");
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// shopify.service — importShopifyPosts
// ---------------------------------------------------------------------------

describe("shopify.service — importShopifyPosts", () => {
  it("13. Returns normalised posts from mocked Shopify Admin API response", async () => {
    const { importShopifyPosts } = await import("./shopify.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (_: string) => null } as any,
      json: async () => ({
        blogs: [{ id: 1, handle: "news" }],
        articles: [
          {
            id: 101,
            title: "Shopify Article",
            body_html: "<p>Shopify content</p>",
            handle: "shopify-article",
            published_at: "2024-01-01T00:00:00Z",
            status: "active",
            author: "Shopify Author",
            blog_id: 1,
          },
        ],
      }),
    } as unknown as Response);

    const result = await importShopifyPosts(
      { shop: "test.myshopify.com", accessToken: "shpat_test" },
      "all"
    );
    expect(result.posts.length).toBeGreaterThanOrEqual(1);
    expect(result.posts[0].title).toBe("Shopify Article");
    fetchSpy.mockRestore();
  });

  it("14. Maps Shopify article fields to iAudit post fields correctly", async () => {
    const { importShopifyPosts } = await import("./shopify.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (_: string) => null } as any,
      json: async () => ({
        blogs: [{ id: 1, handle: "news" }],
        articles: [
          {
            id: 202,
            title: "Field Mapping Test",
            body_html: "<p>Body content</p>",
            handle: "field-mapping-test",
            published_at: "2024-06-01T00:00:00Z",
            status: "active",
            author: "Test Author",
            blog_id: 1,
          },
        ],
      }),
    } as unknown as Response);

    const result = await importShopifyPosts(
      { shop: "test.myshopify.com", accessToken: "shpat_test" },
      "all"
    );
    const post = result.posts.find((p) => p.title === "Field Mapping Test");
    expect(post).toBeDefined();
    expect(post!.cmsPostId).toBe("202");
    // cmsPlatform is set when saving to DB, not on the raw import result
    // bodyHtml is the field name on the import result (mapped to bodyOriginal in DB)
    expect(post!.bodyHtml).toBe("<p>Body content</p>");
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// shopify.service — postBackToShopify
// ---------------------------------------------------------------------------

describe("shopify.service — postBackToShopify", () => {
  it("15. Sends PUT to Shopify Admin API with correct article payload", async () => {
    const { postBackToShopify } = await import("./shopify.service");
    // postBackToShopify makes multiple calls:
    // 1. GET article (fetch-then-merge)
    // 2. PUT article (write body)
    // 3. GET metafields (find existing IDs)
    // 4+ POST/PUT metafields (meta title, meta desc)
    const articleResponse = { ok: true, status: 200, json: async () => ({ article: { id: 101, handle: "test-article", body_html: "<p>old</p>" } }) } as Response;
    const putResponse = { ok: true, status: 200, json: async () => ({ article: { id: 101, handle: "test-article" } }) } as Response;
    const metafieldsResponse = { ok: true, status: 200, json: async () => ({ metafields: [] }) } as Response;
    const metaPostResponse = { ok: true, status: 201, json: async () => ({ metafield: { id: 1 } }) } as Response;
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(articleResponse)   // 1. GET article
      .mockResolvedValueOnce(putResponse)        // 2. PUT article
      .mockResolvedValueOnce(metafieldsResponse) // 3. GET metafields
      .mockResolvedValue(metaPostResponse);      // 4+ POST metafields

    const result = await postBackToShopify(
      { shop: "test.myshopify.com", accessToken: "shpat_test" },
      {
        cmsPostId: "101",
        blogId: "1",
        bodyApproved: "<p>Updated content</p>",
        metaTitleApproved: "Updated Title",
        metaDescriptionApproved: "Updated description",
        imageAltTexts: [],
        authorIdCms: "author-1",
      },
      null
    );
    expect(result.schemaInjected).toBeDefined();
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("16. Throws PostBackException(post_not_found) on 404", async () => {
    const { postBackToShopify } = await import("./shopify.service");
        const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ errors: "Not Found" }),
    } as Response);
    let thrown: any;
    try {
      await postBackToShopify(
        { shop: "test.myshopify.com", accessToken: "shpat_test" },
        { cmsPostId: "999", blogId: "1", bodyApproved: "<p>x</p>", metaTitleApproved: "T", metaDescriptionApproved: "D", imageAltTexts: [], authorIdCms: "a1" },
        null
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe("post_not_found");
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// zapier.service — sendZapierPostBack
// ---------------------------------------------------------------------------

describe("zapier.service — postBackViaZapier", () => {
  it("17. POSTs correct payload to outbound webhook URL", async () => {
    const { postBackViaZapier } = await import("./zapier.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "ok",
    } as Response);

    await postBackViaZapier(
      { webhookSecret: "secret", outboundWebhookUrl: "https://hooks.zapier.com/test" },
      {
        postId: "post-1",
        title: "Test Post",
        bodyApproved: "<p>Content</p>",
        metaTitle: "Title",
        metaDescription: "Desc",
        scoreAfter: 14,
        gradeAfter: "Optimised",
        postUrl: "https://example.com/post",
      },
      null
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.zapier.com/test",
      expect.objectContaining({ method: "POST" })
    );
    fetchSpy.mockRestore();
  });

  it("18. Throws Error with message site_unreachable on network error", async () => {
    const { postBackViaZapier } = await import("./zapier.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    let thrown: any;
    try {
      await postBackViaZapier(
        { webhookSecret: "secret", outboundWebhookUrl: "https://hooks.zapier.com/test" },
        { postId: "p1", title: "T", bodyApproved: "<p>x</p>", metaTitle: "T", metaDescription: "D", scoreAfter: 10, gradeAfter: "Needs Work", postUrl: "https://example.com/p" },
        null
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe("site_unreachable");
    fetchSpy.mockRestore();
  });

  it("19. Returns success object when outbound URL returns 200", async () => {
    const { postBackViaZapier } = await import("./zapier.service");
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "ok",
    } as Response);

    const result = await postBackViaZapier(
      { webhookSecret: "secret", outboundWebhookUrl: "https://hooks.zapier.com/test" },
      { postId: "p1", title: "T", bodyApproved: "<p>x</p>", metaTitle: "T", metaDescription: "D", scoreAfter: 14, gradeAfter: "Optimised", postUrl: "https://example.com/p" },
      null
    );
    expect(result.success).toBe(true);
    expect(result.schemaInjected).toBe(false);
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// tRPC — cms.connectWix
// ---------------------------------------------------------------------------

describe("tRPC — cms.connectWix", () => {
  it("20. Creates a new Wix connection and returns connectionId", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ posts: [] }),
    } as Response);

    const caller = makeCaller(testUserId);
    const result = await caller.cms.connectWix({
      iauditUserId: testUserId,
      businessId,
      siteId: "new-wix-site",
      apiKey: "new-wix-key",
    });
    expect(result.connectionId).toBeDefined();
    expect(typeof result.connectionId).toBe("string");
    fetchSpy.mockRestore();
  });

  it("21. Returns FORBIDDEN when businessId belongs to another user", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ posts: [] }),
    } as Response);

    const caller = makeCaller(testUserId);
    await expect(
      caller.cms.connectWix({
        iauditUserId: testUserId,
        businessId: otherBusinessId, // belongs to otherUserId
        siteId: "wix-site",
        apiKey: "wix-key",
      })
    ).rejects.toThrow();
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// tRPC — cms.connectShopify
// ---------------------------------------------------------------------------

describe("tRPC — cms.connectShopify", () => {
  it("22. Creates a new Shopify connection and returns connectionId", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ blogs: [] }),
    } as Response);

    const caller = makeCaller(testUserId);
    const result = await caller.cms.connectShopify({
      iauditUserId: testUserId,
      businessId,
      shop: "new-store.myshopify.com",
      accessToken: "shpat_new",
    });
    expect(result.connectionId).toBeDefined();
    expect(typeof result.connectionId).toBe("string");
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// tRPC — cms.connectZapier
// ---------------------------------------------------------------------------

describe("tRPC — cms.connectZapier", () => {
  it("23. Creates a new Zapier connection and returns connectionId + inboundUrl", async () => {
    const caller = makeCaller(testUserId);
    const result = await caller.cms.connectZapier({
      iauditUserId: testUserId,
      businessId,
      outboundWebhookUrl: "https://hooks.zapier.com/hooks/catch/test-new",
    });
    expect(result.connectionId).toBeDefined();
    expect(result.inboundUrl).toBeDefined();
  });

  it("24. Returns inboundUrl containing the webhookSecret", async () => {
    const caller = makeCaller(testUserId);
    const result = await caller.cms.connectZapier({
      iauditUserId: testUserId,
      businessId,
    });
    expect(result.inboundUrl).toContain("/api/zapier/inbound/");
    expect(result.webhookSecret).toBeDefined();
    expect(result.inboundUrl).toContain(result.webhookSecret);
  });
});

// ---------------------------------------------------------------------------
// tRPC — postback.runPostBack (Wix)
// ---------------------------------------------------------------------------

describe("tRPC — postback.runPostBack (Wix)", () => {
  it("25. Dispatches to postBackToWix for wix platform connections", async () => {
    const wixService = await import("./wix.service");
    const postBackSpy = vi.spyOn(wixService, "postBackToWix").mockResolvedValueOnce({
      schemaInjected: false,
      schemaFallbackJson: null,
    });

    const caller = makeCaller(testUserId);
    const result = await caller.postback.runPostBack({
      postId: wixPostId,
      iauditUserId: testUserId,
    });
    expect(postBackSpy).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    postBackSpy.mockRestore();
  });
});
