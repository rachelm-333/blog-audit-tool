/**
 * Layer 5 — Keyword Identification Tests
 *
 * Tests:
 *   1. extractFirst500Words — strips HTML tags from content
 *   2. extractFirst500Words — limits output to 500 words
 *   3. extractFirst500Words — handles empty string
 *   4. extractFirst500Words — handles plain text (no HTML)
 *   5. extractFirst500Words — collapses multiple whitespace
 *   6. detectCannibalisation — returns empty result for posts with no keywords
 *   7. detectCannibalisation — returns empty result when all keywords are unique
 *   8. detectCannibalisation — flags posts sharing the same keyword
 *   9. detectCannibalisation — comparison is case-insensitive
 *   10. detectCannibalisation — trims whitespace before comparing
 *   11. detectCannibalisation — skips posts with null focusKeyword
 *   12. detectCannibalisation — three posts sharing same keyword all flagged
 *   13. detectCannibalisation — unflagged posts not in flaggedPostIds
 *   14. detectCannibalisation — multiple duplicate groups detected simultaneously
 *   15. keyword.suggest tRPC — throws NOT_FOUND for unknown postId
 *   16. keyword.suggest tRPC — throws FORBIDDEN when post belongs to different user
 *   17. keyword.confirm tRPC — throws NOT_FOUND for unknown postId
 *   18. keyword.confirm tRPC — throws FORBIDDEN when post belongs to different user
 *   19. keyword.confirm tRPC — returns success: true on valid input
 *   20. keyword.runCannibalisationScan tRPC — throws NOT_FOUND for unknown businessId
 *   21. keyword.runCannibalisationScan tRPC — throws FORBIDDEN for wrong user
 *   22. keyword.listPosts tRPC — throws NOT_FOUND for unknown businessId
 *   23. keyword.listPosts tRPC — returns posts array for valid business
 *   24. keyword DB — updatePostKeyword sets keyword and source
 *   25. keyword DB — listPostsForBusiness returns correct fields
 *   26. keyword DB — updateCannibalisationFlags sets flags correctly
 *   27. keyword DB — getPostForKeyword returns null for unknown postId
 *   28. keyword DB — getPostForKeyword returns post fields for known postId
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";
import {
  extractFirst500Words,
  detectCannibalisation,
} from "./keyword.service";
import {
  updatePostKeyword,
  listPostsForBusiness,
  updateCannibalisationFlags,
  getPostForKeyword,
} from "./keyword.db";

// ---------------------------------------------------------------------------
// extractFirst500Words
// ---------------------------------------------------------------------------

describe("extractFirst500Words", () => {
  it("strips HTML tags from content", () => {
    const html = "<h1>Hello</h1><p>World</p>";
    const result = extractFirst500Words(html);
    expect(result).not.toContain("<h1>");
    expect(result).not.toContain("<p>");
    expect(result).toContain("Hello");
    expect(result).toContain("World");
  });

  it("limits output to 500 words", () => {
    const words = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const result = extractFirst500Words(words);
    const count = result.split(" ").length;
    expect(count).toBe(500);
  });

  it("handles empty string", () => {
    expect(extractFirst500Words("")).toBe("");
  });

  it("handles plain text with no HTML", () => {
    const text = "This is plain text without any HTML tags.";
    const result = extractFirst500Words(text);
    expect(result).toBe(text);
  });

  it("collapses multiple whitespace", () => {
    const html = "<p>Hello   World</p>";
    const result = extractFirst500Words(html);
    expect(result).not.toMatch(/\s{2,}/);
  });
});

// ---------------------------------------------------------------------------
// detectCannibalisation
// ---------------------------------------------------------------------------

describe("detectCannibalisation", () => {
  it("returns empty result for posts with no keywords", () => {
    const posts = [
      { id: "p1", focusKeyword: null },
      { id: "p2", focusKeyword: null },
    ];
    const result = detectCannibalisation(posts);
    expect(result.flaggedPostIds).toHaveLength(0);
    expect(result.duplicateGroups).toHaveLength(0);
  });

  it("returns empty result when all keywords are unique", () => {
    const posts = [
      { id: "p1", focusKeyword: "coffee shops melbourne" },
      { id: "p2", focusKeyword: "best cafes sydney" },
      { id: "p3", focusKeyword: "brunch spots brisbane" },
    ];
    const result = detectCannibalisation(posts);
    expect(result.flaggedPostIds).toHaveLength(0);
    expect(result.duplicateGroups).toHaveLength(0);
  });

  it("flags posts sharing the same keyword", () => {
    const posts = [
      { id: "p1", focusKeyword: "coffee shops melbourne" },
      { id: "p2", focusKeyword: "coffee shops melbourne" },
      { id: "p3", focusKeyword: "best cafes sydney" },
    ];
    const result = detectCannibalisation(posts);
    expect(result.flaggedPostIds).toContain("p1");
    expect(result.flaggedPostIds).toContain("p2");
    expect(result.flaggedPostIds).not.toContain("p3");
    expect(result.duplicateGroups).toHaveLength(1);
    expect(result.duplicateGroups[0].keyword).toBe("coffee shops melbourne");
  });

  it("comparison is case-insensitive", () => {
    const posts = [
      { id: "p1", focusKeyword: "Coffee Shops Melbourne" },
      { id: "p2", focusKeyword: "coffee shops melbourne" },
    ];
    const result = detectCannibalisation(posts);
    expect(result.flaggedPostIds).toHaveLength(2);
    expect(result.duplicateGroups).toHaveLength(1);
  });

  it("trims whitespace before comparing", () => {
    const posts = [
      { id: "p1", focusKeyword: "  coffee shops  " },
      { id: "p2", focusKeyword: "coffee shops" },
    ];
    const result = detectCannibalisation(posts);
    expect(result.flaggedPostIds).toHaveLength(2);
  });

  it("skips posts with null focusKeyword", () => {
    const posts = [
      { id: "p1", focusKeyword: null },
      { id: "p2", focusKeyword: "coffee shops" },
      { id: "p3", focusKeyword: "coffee shops" },
    ];
    const result = detectCannibalisation(posts);
    expect(result.flaggedPostIds).not.toContain("p1");
    expect(result.flaggedPostIds).toContain("p2");
    expect(result.flaggedPostIds).toContain("p3");
  });

  it("three posts sharing same keyword all flagged", () => {
    const posts = [
      { id: "p1", focusKeyword: "seo tips" },
      { id: "p2", focusKeyword: "seo tips" },
      { id: "p3", focusKeyword: "seo tips" },
    ];
    const result = detectCannibalisation(posts);
    expect(result.flaggedPostIds).toHaveLength(3);
    expect(result.duplicateGroups[0].postIds).toHaveLength(3);
  });

  it("unflagged posts not in flaggedPostIds", () => {
    const posts = [
      { id: "p1", focusKeyword: "seo tips" },
      { id: "p2", focusKeyword: "seo tips" },
      { id: "p3", focusKeyword: "unique keyword" },
    ];
    const result = detectCannibalisation(posts);
    expect(result.flaggedPostIds).not.toContain("p3");
  });

  it("multiple duplicate groups detected simultaneously", () => {
    const posts = [
      { id: "p1", focusKeyword: "seo tips" },
      { id: "p2", focusKeyword: "seo tips" },
      { id: "p3", focusKeyword: "content marketing" },
      { id: "p4", focusKeyword: "content marketing" },
      { id: "p5", focusKeyword: "unique keyword" },
    ];
    const result = detectCannibalisation(posts);
    expect(result.duplicateGroups).toHaveLength(2);
    expect(result.flaggedPostIds).toHaveLength(4);
    expect(result.flaggedPostIds).not.toContain("p5");
  });
});

// ---------------------------------------------------------------------------
// tRPC keyword router — unit tests (mocked DB)
// ---------------------------------------------------------------------------

describe("tRPC keyword.suggest", () => {
  it("throws NOT_FOUND for unknown postId", async () => {
    vi.mock("./keyword.db", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./keyword.db")>();
      return {
        ...actual,
        // Use real implementations as defaults so DB helper tests work correctly.
        // tRPC tests override with mockResolvedValueOnce where needed.
        getPostForKeyword: vi.fn().mockImplementation(actual.getPostForKeyword),
        listPostsForBusiness: vi.fn().mockImplementation(actual.listPostsForBusiness),
        updatePostKeyword: vi.fn().mockImplementation(actual.updatePostKeyword),
        updateCannibalisationFlags: vi.fn().mockImplementation(actual.updateCannibalisationFlags),
      };
    });

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    await expect(
      caller.keyword.suggest({ postId: "nonexistent", iauditUserId: "user1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws FORBIDDEN when post belongs to different user", async () => {
    const { getPostForKeyword } = await import("./keyword.db");
    const { getBusinessById } = await import("./businesses.db");

    vi.mocked(getPostForKeyword).mockResolvedValueOnce({
      id: "post1",
      title: "Test Post",
      bodyOriginal: "Some content",
      focusKeyword: null,
      keywordSource: null,
      businessId: "biz1",
    });

    vi.spyOn(await import("./businesses.db"), "getBusinessById").mockResolvedValueOnce({
      id: "biz1",
      userId: "other-user",
      name: "Test Business",
      websiteUrl: "https://example.com",
      brandVoice: null,
      industry: null,
      targetAudience: null,
      scrapeStatus: "complete",
      scrapeFailureType: null,
      stage1Complete: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    await expect(
      caller.keyword.suggest({ postId: "post1", iauditUserId: "user1" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("tRPC keyword.confirm", () => {
  it("throws NOT_FOUND for unknown postId", async () => {
    const { getPostForKeyword } = await import("./keyword.db");
    vi.mocked(getPostForKeyword).mockResolvedValueOnce(null);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    await expect(
      caller.keyword.confirm({
        postId: "nonexistent",
        keyword: "test keyword",
        source: "user_entered",
        iauditUserId: "user1",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws FORBIDDEN when post belongs to different user", async () => {
    const { getPostForKeyword } = await import("./keyword.db");
    vi.mocked(getPostForKeyword).mockResolvedValueOnce({
      id: "post1",
      title: "Test Post",
      bodyOriginal: "Some content",
      focusKeyword: null,
      keywordSource: null,
      businessId: "biz1",
    });

    vi.spyOn(await import("./businesses.db"), "getBusinessById").mockResolvedValueOnce({
      id: "biz1",
      userId: "other-user",
    } as any);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    await expect(
      caller.keyword.confirm({
        postId: "post1",
        keyword: "test keyword",
        source: "user_entered",
        iauditUserId: "user1",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns success: true on valid input", async () => {
    const userId = nanoid(21);
    const { getPostForKeyword, updatePostKeyword } = await import("./keyword.db");

    vi.mocked(getPostForKeyword).mockResolvedValueOnce({
      id: "post1",
      title: "Test Post",
      bodyOriginal: "Some content",
      focusKeyword: null,
      keywordSource: null,
      businessId: "biz1",
    });

    vi.spyOn(await import("./businesses.db"), "getBusinessById").mockResolvedValueOnce({
      id: "biz1",
      userId,
    } as any);

    vi.mocked(updatePostKeyword).mockResolvedValueOnce(undefined);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    const result = await caller.keyword.confirm({
      postId: "post1",
      keyword: "test keyword",
      source: "user_entered",
      iauditUserId: userId,
    });
    expect(result).toEqual({ success: true });
  });
});

describe("tRPC keyword.runCannibalisationScan", () => {
  it("throws NOT_FOUND for unknown businessId", async () => {
    vi.spyOn(await import("./businesses.db"), "getBusinessById").mockResolvedValueOnce(undefined as any);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    await expect(
      caller.keyword.runCannibalisationScan({
        businessId: "nonexistent",
        iauditUserId: "user1",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws FORBIDDEN for wrong user", async () => {
    vi.spyOn(await import("./businesses.db"), "getBusinessById").mockResolvedValueOnce({
      id: "biz1",
      userId: "other-user",
    } as any);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    await expect(
      caller.keyword.runCannibalisationScan({
        businessId: "biz1",
        iauditUserId: "user1",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("tRPC keyword.listPosts", () => {
  it("throws NOT_FOUND for unknown businessId", async () => {
    vi.spyOn(await import("./businesses.db"), "getBusinessById").mockResolvedValueOnce(undefined as any);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    await expect(
      caller.keyword.listPosts({
        businessId: "nonexistent",
        iauditUserId: "user1",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns posts array for valid business", async () => {
    const userId = nanoid(21);
    vi.spyOn(await import("./businesses.db"), "getBusinessById").mockResolvedValueOnce({
      id: "biz1",
      userId,
    } as any);

    const { listPostsForBusiness } = await import("./keyword.db");
    vi.mocked(listPostsForBusiness).mockResolvedValueOnce([
      {
        id: "post1",
        title: "Test Post",
        url: "https://example.com/test",
        focusKeyword: "test keyword",
        keywordSource: "cms_scraped",
        cannibalizationFlag: false,
      },
    ]);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });
    const result = await caller.keyword.listPosts({
      businessId: "biz1",
      iauditUserId: userId,
    });
    expect(result.posts).toHaveLength(1);
    expect(result.posts[0].focusKeyword).toBe("test keyword");
  });
});

// ---------------------------------------------------------------------------
// keyword DB helpers — integration tests (real DB)
// ---------------------------------------------------------------------------

describe("keyword DB helpers", () => {
  let businessId: string;
  let userId: string;
  let postId: string;

  beforeAll(async () => {
    // Create a user, business, and post for DB tests
    const { createIauditUser } = await import("./iauth.db");
    const { createCmsConnection, upsertPost } = await import("./cms.db");

    userId = nanoid(21);
    businessId = nanoid(21);
    postId = nanoid(21);

    await createIauditUser({
      id: userId,
      email: `kwtest_${userId}@example.com`,
      name: "KW Test User",
      passwordHash: "hash",
      accountType: "solo",
      emailVerified: true,
    });

    const db = await (await import("./db")).getDb();
    if (!db) throw new Error("DB not available");
    const { businesses } = await import("../drizzle/schema");
    await db.insert(businesses).values({
      id: businessId,
      userId,
      businessName: "KW Test Business",
      websiteUrl: "https://kwtest.example.com",
      industry: "Technology",
      location: "Brisbane, QLD",
      brandVoice: "Confident and clear",
      tone: "Professional",
      targetAudience: "SMEs",
      uvp: "We deliver results",
      services: ["SEO"],
      primaryCtaUrl: "https://kwtest.example.com/contact",
      primaryCtaLabel: "Contact Us",
      scrapeStatus: "complete",
      stage1Complete: true,
    });

    await createCmsConnection({
      businessId,
      platform: "wordpress",
      siteUrl: "https://kwtest.example.com",
      credentials: {
        siteUrl: "https://kwtest.example.com",
        username: "admin",
        applicationPassword: "pass",
      },
    });

    await upsertPost({
      businessId,
      cmsPlatform: "wordpress",
      cmsPostId: "wp-kw-1",
      title: "KW Test Post",
      bodyHtml: "<p>Some content about coffee shops in Melbourne.</p>",
      url: "https://kwtest.example.com/kw-test-post",
      status: "published",
      publishDate: null,
      scheduledDate: null,
      authorIdCms: "1",
      authorNameCms: "Admin",
      focusKeyword: null,
      metaTitle: null,
      metaDescription: null,
      featuredImageUrl: null,
      featuredImageAlt: null,
      bodyImageAlts: [],
      categories: [],
      tags: [],
    });

    // Get the inserted post ID
    const { getPostsByBusinessId } = await import("./cms.db");
    const posts = await getPostsByBusinessId(businessId);
    if (posts.length > 0) {
      postId = posts[0].id;
    }
  });

  afterAll(async () => {
    // Cleanup — delete in FK-safe order
    const { getDb } = await import("./db");
    const db = await getDb();
    if (!db) return;
    const { posts, businesses, iauditUsers, cmsConnections } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(posts).where(eq(posts.businessId, businessId));
    await db.delete(cmsConnections).where(eq(cmsConnections.businessId, businessId));
    await db.delete(businesses).where(eq(businesses.id, businessId));
    await db.delete(iauditUsers).where(eq(iauditUsers.id, userId));
  });

  it("getPostForKeyword returns null for unknown postId", async () => {
    const result = await getPostForKeyword("nonexistent-post-id");
    expect(result).toBeNull();
  });

  it("getPostForKeyword returns post fields for known postId", async () => {
    const result = await getPostForKeyword(postId);
    expect(result).not.toBeNull();
    expect(result?.title).toBe("KW Test Post");
    expect(result?.businessId).toBe(businessId);
  });

  it("updatePostKeyword sets keyword and source", async () => {
    await updatePostKeyword(postId, "coffee shops melbourne", "user_entered");
    const result = await getPostForKeyword(postId);
    expect(result?.focusKeyword).toBe("coffee shops melbourne");
    expect(result?.keywordSource).toBe("user_entered");
  });

  it("listPostsForBusiness returns correct fields", async () => {
    const posts = await listPostsForBusiness(businessId);
    expect(posts.length).toBeGreaterThan(0);
    const post = posts.find((p) => p.id === postId);
    expect(post).toBeDefined();
    expect(post?.title).toBe("KW Test Post");
    expect(post?.focusKeyword).toBe("coffee shops melbourne");
  });

  it("updateCannibalisationFlags sets flags correctly", async () => {
    await updateCannibalisationFlags([postId], []);
    const posts = await listPostsForBusiness(businessId);
    const post = posts.find((p) => p.id === postId);
    expect(post?.cannibalizationFlag).toBe(true);

    // Unset the flag
    await updateCannibalisationFlags([], [postId]);
    const posts2 = await listPostsForBusiness(businessId);
    const post2 = posts2.find((p) => p.id === postId);
    expect(post2?.cannibalizationFlag).toBe(false);
  });
});
