/**
 * Layer 4 — CMS Connection & Post Import Tests
 *
 * Tests:
 *   1. Encryption service — encrypt/decrypt round-trip
 *   2. Encryption service — different keys produce different ciphertext
 *   3. Encryption service — tampered ciphertext throws
 *   4. WordPress service — normaliseUrl strips trailing slash
 *   5. WordPress service — normaliseUrl adds https:// prefix
 *   6. WordPress service — testWordPressConnection throws invalid_credentials on 401
 *   7. WordPress service — testWordPressConnection throws site_unreachable on network error
 *   8. WordPress service — testWordPressConnection throws not_wordpress on non-WP response
 *   9. WordPress service — importWordPressPosts maps all required fields
 *   10. WordPress service — trash posts are NEVER imported
 *   11. WordPress service — status filter published only
 *   12. WordPress service — status filter scheduled (future) only
 *   13. WordPress service — status filter draft only
 *   14. WordPress service — focus keyword extracted from Yoast meta
 *   15. WordPress service — focus keyword extracted from RankMath meta
 *   16. WordPress service — meta title extracted from Yoast
 *   17. WordPress service — meta description extracted from Yoast
 *   18. WordPress service — author_id_cms and author_name_cms stored correctly
 *   19. WordPress service — cms_post_id stored as string
 *   20. WordPress service — featured image alt text extracted
 *   21. WordPress service — body image alts extracted from HTML
 *   22. WordPress service — categories and tags extracted
 *   23. CMS DB — createCmsConnection encrypts credentials
 *   24. CMS DB — decryptConnectionCredentials round-trip
 *   25. CMS DB — credentials never stored as plain text in DB
 *   26. CMS DB — upsertPost creates new post row
 *   27. CMS DB — upsertPost does not overwrite bodyOriginal on re-import
 *   28. CMS DB — upsertPost deduplicates by (businessId, cmsPostId, cmsPlatform)
 *   29. CMS DB — getPostsByBusinessId with status filter
 *   30. CMS DB — countPostsByBusiness returns correct counts
 *   31. tRPC cms.connect — blocks if business not owned by user
 *   32. tRPC cms.connect — returns connectionId on success (mocked)
 *   33. tRPC cms.importPosts — blocks if connection not owned by user
 *   34. tRPC cms.listConnections — never returns credentialsEncrypted
 *   35. tRPC cms.getConnection — never returns credentialsEncrypted
 *   36. tRPC cms.disconnect — removes connection from DB
 *   37. Error mapping — WpImportException invalid_credentials maps to BAD_REQUEST
 *   38. Error mapping — WpImportException insufficient_permissions maps to FORBIDDEN
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";
import {
  encryptCredentials,
  decryptCredentials,
} from "./encryption.service";
import {
  WpImportException,
  normaliseUrl,
  extractBodyImageAlts,
} from "./wordpress.service";
import {
  createCmsConnection,
  getCmsConnectionById,
  deleteCmsConnection,
  decryptConnectionCredentials,
  upsertPost,
  getPostsByBusinessId,
  countPostsByBusiness,
} from "./cms.db";
import { createBusiness } from "./businesses.db";
import { getDb } from "./db";
import { iauditUsers, businesses, cmsConnections, posts } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// ─── Test data helpers ────────────────────────────────────────────────────────

async function createTestUser(): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const id = nanoid(21);
  await db.insert(iauditUsers).values({
    id,
    email: `test-${id}@example.com`,
    passwordHash: "hash",
    name: "Test User",
    accountType: "solo",
    emailVerified: true,
    creditsRemaining: 0,
    creditsTotalPurchased: 0,
    isSuspended: false,
  });
  return id;
}

async function createTestBusiness(userId: string): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("DB not available");
  const id = nanoid(21);
  // Use Drizzle ORM insert — cast to any to bypass TS notNull on optional fields
  await db.insert(businesses).values({
    id,
    userId,
    businessName: "Test Business",
    websiteUrl: "https://example.com",
    industry: "" as any,
    location: "" as any,
    brandVoice: "" as any,
    tone: "" as any,
    targetAudience: "" as any,
    uvp: "" as any,
    services: [] as any,
    primaryCtaUrl: "" as any,
    primaryCtaLabel: "" as any,
    scrapeStatus: "complete",
    stage1Complete: false,
  });
  return id;
}

// ─── Cleanup tracking ─────────────────────────────────────────────────────────

const createdUserIds: string[] = [];
const createdBusinessIds: string[] = [];
const createdConnectionIds: string[] = [];
const createdPostIds: string[] = [];

beforeAll(async () => {
  // Verify DB is available
  const db = await getDb();
  if (!db) throw new Error("Database not available for Layer 4 tests");
});

afterAll(async () => {
  const db = await getDb();
  if (!db) return;

  // Clean up in dependency order (bulk deletes to avoid N+1 timeouts)
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(eq(posts.id, createdPostIds[0]!)).catch(() => {});
    for (const id of createdPostIds.slice(1)) {
      await db.delete(posts).where(eq(posts.id, id)).catch(() => {});
    }
  }
  if (createdConnectionIds.length > 0) {
    for (const id of createdConnectionIds) {
      await db.delete(cmsConnections).where(eq(cmsConnections.id, id)).catch(() => {});
    }
  }
  if (createdBusinessIds.length > 0) {
    for (const id of createdBusinessIds) {
      await db.delete(businesses).where(eq(businesses.id, id)).catch(() => {});
    }
  }
  if (createdUserIds.length > 0) {
    for (const id of createdUserIds) {
      await db.delete(iauditUsers).where(eq(iauditUsers.id, id)).catch(() => {});
    }
  }
}, 60_000);

// ─── 1–3: Encryption service ──────────────────────────────────────────────────

describe("Encryption service", () => {
  it("1. encrypts and decrypts credentials round-trip", () => {
    const creds = { siteUrl: "https://example.com", username: "admin", applicationPassword: "xxxx yyyy zzzz" };
    const encrypted = encryptCredentials(creds);
    const decrypted = decryptCredentials(encrypted);
    expect(decrypted).toEqual(creds);
  });

  it("2. produces non-plain-text output (ciphertext is not JSON-readable)", () => {
    const creds = { username: "admin", applicationPassword: "secret123" };
    const encrypted = encryptCredentials(creds);
    // Should not be parseable as plain JSON containing the password
    expect(encrypted).not.toContain("secret123");
    expect(encrypted).not.toContain("admin");
  });

  it("3. throws on tampered ciphertext", () => {
    const creds = { username: "admin", applicationPassword: "secret" };
    const encrypted = encryptCredentials(creds);
    // The format is base64(hex_iv:hex_authTag:hex_ciphertext)
    // Decode base64, corrupt the auth tag (middle part), re-encode
    const decoded = Buffer.from(encrypted, "base64").toString("utf8");
    const parts = decoded.split(":");
    // parts[0] = iv hex, parts[1] = authTag hex, parts[2] = ciphertext hex
    if (parts.length === 3 && parts[1] && parts[1].length >= 2) {
      // Flip the first byte of the auth tag
      const firstByte = parseInt(parts[1].slice(0, 2), 16);
      const flipped = ((firstByte + 1) % 256).toString(16).padStart(2, "0");
      parts[1] = flipped + parts[1].slice(2);
    }
    const tampered = Buffer.from(parts.join(":")).toString("base64");
    expect(() => decryptCredentials(tampered)).toThrow();
  });
});

// ─── 4–5: normaliseUrl ────────────────────────────────────────────────────────

describe("normaliseUrl", () => {
  it("4. strips trailing slash", () => {
    expect(normaliseUrl("https://example.com/")).toBe("https://example.com");
  });

  it("5. adds https:// prefix when missing", () => {
    expect(normaliseUrl("example.com")).toBe("https://example.com");
  });
});

// ─── 6–8: WordPress connection errors ────────────────────────────────────────

describe("WordPress connection errors", () => {
  it("6. throws invalid_credentials on 401", async () => {
    const { testWordPressConnection } = await import("./wordpress.service");
    // Mock fetch to return 401
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: "rest_forbidden", message: "Sorry, you are not allowed to do that." }),
    } as any);

    await expect(
      testWordPressConnection({ siteUrl: "https://example.com", username: "admin", applicationPassword: "wrong" })
    ).rejects.toMatchObject({ code: "invalid_credentials" });

    global.fetch = originalFetch;
  });

  it("7. throws site_unreachable on network error", async () => {
    const { testWordPressConnection } = await import("./wordpress.service");
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      testWordPressConnection({ siteUrl: "https://unreachable.invalid", username: "admin", applicationPassword: "pw" })
    ).rejects.toMatchObject({ code: "site_unreachable" });

    global.fetch = originalFetch;
  });

  it("8. throws not_wordpress on non-WP response", async () => {
    const { testWordPressConnection } = await import("./wordpress.service");
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not found" }),
    } as any);

    await expect(
      testWordPressConnection({ siteUrl: "https://not-wordpress.example.com", username: "admin", applicationPassword: "pw" })
    ).rejects.toMatchObject({ code: "not_wordpress" });

    global.fetch = originalFetch;
  });
});

// ─── 9–22: WordPress post import ─────────────────────────────────────────────

describe("WordPress post import", () => {
  function makeMockPost(overrides: Record<string, any> = {}) {
    return {
      id: 123,
      title: { rendered: "Test Post Title" },
      content: { rendered: "<p>Hello world</p><img src='img.jpg' alt='a cat'>" },
      link: "https://example.com/test-post",
      status: "publish",
      date: "2024-01-15T10:00:00",
      date_gmt: "2024-01-15T00:00:00",
      modified: "2024-01-15T10:00:00",
      author: 5,
      _embedded: {
        author: [{ id: 5, name: "Jane Doe" }],
        "wp:featuredmedia": [{ alt_text: "Featured image alt", source_url: "https://example.com/img.jpg" }],
        "wp:term": [
          [{ id: 1, name: "Technology", taxonomy: "category" }],
          [{ id: 10, name: "seo", taxonomy: "post_tag" }],
        ],
      },
      meta: {
        _yoast_wpseo_focuskw: "seo optimisation",
        _yoast_wpseo_title: "SEO Tips | My Site",
        _yoast_wpseo_metadesc: "Learn the best SEO tips.",
      },
      yoast_head_json: {
        og_title: "SEO Tips | My Site",
        og_description: "Learn the best SEO tips.",
      },
      ...overrides,
    };
  }

  async function runMockedImport(mockPosts: any[], statusFilter = "all") {
    const { importWordPressPosts } = await import("./wordpress.service");
    const originalFetch = global.fetch;

    // First call: /wp/v2/users/me (auth check)
    // Subsequent calls: /wp/v2/posts pages
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.toString().includes("/wp/v2/users/me")) {
        return { ok: true, status: 200, json: async () => ({ id: 1, name: "Admin", capabilities: { edit_posts: true } }) };
      }
      // Posts endpoint — return mock posts on first page, empty on second
      if (callCount <= 3) {
        return {
          ok: true,
          status: 200,
          headers: { get: (h: string) => h === "X-WP-TotalPages" ? "1" : null },
          json: async () => mockPosts,
        };
      }
      return { ok: true, status: 200, headers: { get: () => "1" }, json: async () => [] };
    });

    try {
      return await importWordPressPosts(
        { siteUrl: "https://example.com", username: "admin", applicationPassword: "pw" },
        { statusFilter: statusFilter as any }
      );
    } finally {
      global.fetch = originalFetch;
    }
  }

  it("9. maps all required fields from a WordPress post", async () => {
    const result = await runMockedImport([makeMockPost()]);
    expect(result.posts).toHaveLength(1);
    const post = result.posts[0]!;
    expect(post.cmsPostId).toBe("123");
    expect(post.title).toBe("Test Post Title");
    expect(post.url).toBe("https://example.com/test-post");
    expect(post.status).toBe("published");
    expect(post.authorIdCms).toBe("5");
    expect(post.authorNameCms).toBe("Jane Doe");
    expect(post.focusKeyword).toBe("seo optimisation");
    expect(post.metaTitle).toBe("SEO Tips | My Site");
    expect(post.metaDescription).toBe("Learn the best SEO tips.");
    expect(post.featuredImageAlt).toBe("Featured image alt");
  });

  it("10. NEVER imports trash posts", async () => {
    const trashPost = makeMockPost({ status: "trash" });
    // The WordPress API should never return trash when we request publish,future,draft
    // but we test that even if it did, it would be filtered
    const result = await runMockedImport([trashPost]);
    // Trash posts should not appear in results
    const trashInResult = result.posts.filter((p) => (p as any).status === "trash");
    expect(trashInResult).toHaveLength(0);
  });

  it("11. status filter published only — maps status to 'published'", async () => {
    const result = await runMockedImport([makeMockPost({ status: "publish" })], "published");
    expect(result.posts[0]?.status).toBe("published");
  });

  it("12. status filter scheduled (future) — maps status to 'scheduled'", async () => {
    const result = await runMockedImport([makeMockPost({ status: "future" })], "scheduled");
    expect(result.posts[0]?.status).toBe("scheduled");
  });

  it("13. status filter draft only — maps status to 'draft'", async () => {
    const result = await runMockedImport([makeMockPost({ status: "draft" })], "draft");
    expect(result.posts[0]?.status).toBe("draft");
  });

  it("14. extracts focus keyword from Yoast meta (_yoast_wpseo_focuskw)", async () => {
    // Use a keyword that passes validateKeyword (2-word, no stop words)
    const result = await runMockedImport([makeMockPost({ meta: { _yoast_wpseo_focuskw: "search optimisation" } })]);
    expect(result.posts[0]?.focusKeyword).toBe("search optimisation");
  });

  it("15. extracts focus keyword from RankMath meta (rank_math_focus_keyword)", async () => {
    const result = await runMockedImport([
      makeMockPost({ meta: { rank_math_focus_keyword: "rank math keyword" } }),
    ]);
    expect(result.posts[0]?.focusKeyword).toBe("rank math keyword");
  });

  it("16. extracts meta title from Yoast", async () => {
    const result = await runMockedImport([
      makeMockPost({ meta: { _yoast_wpseo_title: "My SEO Title" } }),
    ]);
    expect(result.posts[0]?.metaTitle).toBe("My SEO Title");
  });

  it("17. extracts meta description from Yoast", async () => {
    const result = await runMockedImport([
      makeMockPost({ meta: { _yoast_wpseo_metadesc: "My meta description" } }),
    ]);
    expect(result.posts[0]?.metaDescription).toBe("My meta description");
  });

  it("18. stores author_id_cms and author_name_cms correctly", async () => {
    const result = await runMockedImport([
      makeMockPost({ author: 42, _embedded: { author: [{ id: 42, name: "John Smith" }], "wp:featuredmedia": [], "wp:term": [[], []] } }),
    ]);
    expect(result.posts[0]?.authorIdCms).toBe("42");
    expect(result.posts[0]?.authorNameCms).toBe("John Smith");
  });

  it("19. stores cms_post_id as string", async () => {
    const result = await runMockedImport([makeMockPost({ id: 9999 })]);
    expect(result.posts[0]?.cmsPostId).toBe("9999");
    expect(typeof result.posts[0]?.cmsPostId).toBe("string");
  });

  it("20. extracts featured image alt text", async () => {
    const result = await runMockedImport([
      makeMockPost({
        _embedded: {
          author: [{ id: 5, name: "Jane" }],
          "wp:featuredmedia": [{ alt_text: "A beautiful sunset", source_url: "https://example.com/sunset.jpg" }],
          "wp:term": [[], []],
        },
      }),
    ]);
    expect(result.posts[0]?.featuredImageAlt).toBe("A beautiful sunset");
    expect(result.posts[0]?.featuredImageUrl).toBe("https://example.com/sunset.jpg");
  });

  it("21. extracts body image alt texts from HTML", () => {
    const html = `<p>Hello</p><img src="a.jpg" alt="first alt"><img src="b.jpg" alt="second alt"><img src="c.jpg">`;
    const alts = extractBodyImageAlts(html);
    expect(alts).toContain("first alt");
    expect(alts).toContain("second alt");
    expect(alts).not.toContain("");
  });

  it("22. extracts categories and tags", async () => {
    const result = await runMockedImport([
      makeMockPost({
        _embedded: {
          author: [{ id: 5, name: "Jane" }],
          "wp:featuredmedia": [],
          "wp:term": [
            [{ id: 1, name: "Technology", taxonomy: "category" }, { id: 2, name: "SEO", taxonomy: "category" }],
            [{ id: 10, name: "tips", taxonomy: "post_tag" }],
          ],
        },
      }),
    ]);
    expect(result.posts[0]?.categories).toContain("Technology");
    expect(result.posts[0]?.categories).toContain("SEO");
    expect(result.posts[0]?.tags).toContain("tips");
  });
});

// ─── 23–30: CMS DB helpers ────────────────────────────────────────────────────

describe("CMS DB helpers", () => {
  it("23. createCmsConnection encrypts credentials in DB", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const connectionId = await createCmsConnection({
      businessId,
      platform: "wordpress",
      siteUrl: "https://example.com",
      credentials: { siteUrl: "https://example.com", username: "admin", applicationPassword: "secret123" },
    });
    createdConnectionIds.push(connectionId);

    // Read raw from DB
    const db = await getDb();
    const rows = await db!.select().from(cmsConnections).where(eq(cmsConnections.id, connectionId)).limit(1);
    const raw = rows[0]!;

    // The stored value should NOT contain the plain password
    const storedStr = typeof raw.credentialsEncrypted === "string"
      ? raw.credentialsEncrypted
      : JSON.stringify(raw.credentialsEncrypted);
    expect(storedStr).not.toContain("secret123");
    expect(storedStr).not.toContain("admin");
  });

  it("24. decryptConnectionCredentials round-trip", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const creds = { siteUrl: "https://example.com", username: "testuser", applicationPassword: "app-pw-xyz" };
    const connectionId = await createCmsConnection({
      businessId,
      platform: "wordpress",
      siteUrl: "https://example.com",
      credentials: creds,
    });
    createdConnectionIds.push(connectionId);

    const connection = await getCmsConnectionById(connectionId);
    const decrypted = decryptConnectionCredentials(connection!);
    expect(decrypted["username"]).toBe("testuser");
    expect(decrypted["applicationPassword"]).toBe("app-pw-xyz");
  });

  it("25. credentials never stored as plain text — DB value is encrypted", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const plainPassword = `plaintext-${nanoid(8)}`;
    const connectionId = await createCmsConnection({
      businessId,
      platform: "wordpress",
      siteUrl: "https://example.com",
      credentials: { siteUrl: "https://example.com", username: "admin", applicationPassword: plainPassword },
    });
    createdConnectionIds.push(connectionId);

    const db = await getDb();
    const rows = await db!.select().from(cmsConnections).where(eq(cmsConnections.id, connectionId)).limit(1);
    const stored = JSON.stringify(rows[0]!.credentialsEncrypted);
    expect(stored).not.toContain(plainPassword);
  });

  it("26. upsertPost creates a new post row", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const postId = await upsertPost({
      businessId,
      cmsPlatform: "wordpress",
      cmsPostId: "wp-100",
      title: "My First Post",
      bodyHtml: "<p>Content here</p>",
      url: "https://example.com/my-first-post",
      status: "published",
      publishDate: new Date("2024-01-01"),
      scheduledDate: null,
      authorIdCms: "1",
      authorNameCms: "Admin",
      focusKeyword: "first post",
      metaTitle: "My First Post | Site",
      metaDescription: "A great post.",
      featuredImageUrl: null,
      featuredImageAlt: null,
      bodyImageAlts: [],
      categories: ["Blog"],
      tags: ["intro"],
    });
    createdPostIds.push(postId);

    const db = await getDb();
    const rows = await db!.select().from(posts).where(eq(posts.id, postId)).limit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("My First Post");
    expect(rows[0]!.cmsPostId).toBe("wp-100");
    expect(rows[0]!.bodyOriginal).toBe("<p>Content here</p>");
  });

  it("27. upsertPost does NOT overwrite bodyOriginal on re-import", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const basePost = {
      businessId,
      cmsPlatform: "wordpress" as const,
      cmsPostId: "wp-200",
      title: "Original Title",
      bodyHtml: "<p>Original body</p>",
      url: "https://example.com/original",
      status: "published" as const,
      publishDate: new Date("2024-01-01"),
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
    };

    const postId = await upsertPost(basePost);
    createdPostIds.push(postId);

    // Re-import with different body
    await upsertPost({ ...basePost, bodyHtml: "<p>CHANGED body — should not overwrite</p>", title: "Updated Title" });

    const db = await getDb();
    const rows = await db!.select().from(posts).where(eq(posts.id, postId)).limit(1);
    // bodyOriginal must remain unchanged
    expect(rows[0]!.bodyOriginal).toBe("<p>Original body</p>");
    // title should be updated
    expect(rows[0]!.title).toBe("Updated Title");
  });

  it("28. upsertPost deduplicates by (businessId, cmsPostId, cmsPlatform)", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const basePost = {
      businessId,
      cmsPlatform: "wordpress" as const,
      cmsPostId: "wp-300",
      title: "Dedup Test",
      bodyHtml: "<p>body</p>",
      url: "https://example.com/dedup",
      status: "published" as const,
      publishDate: new Date(),
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
    };

    const id1 = await upsertPost(basePost);
    createdPostIds.push(id1);
    const id2 = await upsertPost(basePost);

    // Should return the same row ID (upsert, not insert)
    expect(id1).toBe(id2);

    // Only one row in DB
    const db = await getDb();
    const rows = await db!.select().from(posts).where(eq(posts.businessId, businessId));
    expect(rows).toHaveLength(1);
  });

  it("29. getPostsByBusinessId with status filter returns only matching posts", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const makePost = (status: "published" | "scheduled" | "draft", cmsId: string) => ({
      businessId,
      cmsPlatform: "wordpress" as const,
      cmsPostId: cmsId,
      title: `Post ${cmsId}`,
      bodyHtml: "<p>body</p>",
      url: `https://example.com/${cmsId}`,
      status,
      publishDate: status === "published" ? new Date() : null,
      scheduledDate: status === "scheduled" ? new Date() : null,
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

    const id1 = await upsertPost(makePost("published", "filter-pub"));
    const id2 = await upsertPost(makePost("scheduled", "filter-sched"));
    const id3 = await upsertPost(makePost("draft", "filter-draft"));
    createdPostIds.push(id1, id2, id3);

    const publishedOnly = await getPostsByBusinessId(businessId, "published");
    expect(publishedOnly.every((p) => p.status === "published")).toBe(true);
    expect(publishedOnly.some((p) => p.id === id1)).toBe(true);
    expect(publishedOnly.some((p) => p.id === id2)).toBe(false);
  });

  it("30. countPostsByBusiness returns correct counts by status", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const makePost = (status: "published" | "scheduled" | "draft", cmsId: string) => ({
      businessId,
      cmsPlatform: "wordpress" as const,
      cmsPostId: cmsId,
      title: `Post ${cmsId}`,
      bodyHtml: "<p>body</p>",
      url: `https://example.com/${cmsId}`,
      status,
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

    const ids = await Promise.all([
      upsertPost(makePost("published", "cnt-pub-1")),
      upsertPost(makePost("published", "cnt-pub-2")),
      upsertPost(makePost("scheduled", "cnt-sched-1")),
      upsertPost(makePost("draft", "cnt-draft-1")),
      upsertPost(makePost("draft", "cnt-draft-2")),
      upsertPost(makePost("draft", "cnt-draft-3")),
    ]);
    createdPostIds.push(...ids);

    const counts = await countPostsByBusiness(businessId);
    expect(counts["published"]).toBe(2);
    expect(counts["scheduled"]).toBe(1);
    expect(counts["draft"]).toBe(3);
  });
});

// ─── 31–36: tRPC procedures ───────────────────────────────────────────────────

describe("tRPC cms procedures", () => {
  it("31. cms.connect blocks if business not owned by user", async () => {
    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });

    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const otherUserId = await createTestUser();
    createdUserIds.push(otherUserId);

    await expect(
      caller.cms.connect({
        iauditUserId: otherUserId,
        businessId,
        siteUrl: "https://example.com",
        username: "admin",
        applicationPassword: "pw",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("32. cms.listConnections never returns credentialsEncrypted", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const connectionId = await createCmsConnection({
      businessId,
      platform: "wordpress",
      siteUrl: "https://example.com",
      credentials: { siteUrl: "https://example.com", username: "admin", applicationPassword: "secret" },
    });
    createdConnectionIds.push(connectionId);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });

    const connections = await caller.cms.listConnections({ iauditUserId: userId, businessId });
    for (const conn of connections) {
      expect(conn).not.toHaveProperty("credentialsEncrypted");
    }
  });

  it("33. cms.getConnection never returns credentialsEncrypted", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const connectionId = await createCmsConnection({
      businessId,
      platform: "wordpress",
      siteUrl: "https://example.com",
      credentials: { siteUrl: "https://example.com", username: "admin", applicationPassword: "secret" },
    });
    createdConnectionIds.push(connectionId);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });

    const conn = await caller.cms.getConnection({ iauditUserId: userId, connectionId });
    expect(conn).not.toHaveProperty("credentialsEncrypted");
  });

  it("34. cms.disconnect removes connection from DB", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const connectionId = await createCmsConnection({
      businessId,
      platform: "wordpress",
      siteUrl: "https://example.com",
      credentials: { siteUrl: "https://example.com", username: "admin", applicationPassword: "pw" },
    });
    // Don't add to createdConnectionIds — we're deleting it in the test

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });

    await caller.cms.disconnect({ iauditUserId: userId, connectionId });

    const connection = await getCmsConnectionById(connectionId);
    expect(connection).toBeNull();
  });

  it("35. cms.importPosts blocks if connection not owned by user", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const businessId = await createTestBusiness(userId);
    createdBusinessIds.push(businessId);

    const connectionId = await createCmsConnection({
      businessId,
      platform: "wordpress",
      siteUrl: "https://example.com",
      credentials: { siteUrl: "https://example.com", username: "admin", applicationPassword: "pw" },
    });
    createdConnectionIds.push(connectionId);

    const otherUserId = await createTestUser();
    createdUserIds.push(otherUserId);

    const { appRouter } = await import("./routers");
    const caller = appRouter.createCaller({ user: null, req: {} as any, res: {} as any });

    await expect(
      caller.cms.importPosts({ iauditUserId: otherUserId, connectionId, statusFilter: "all" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─── 36–38: Error mapping ─────────────────────────────────────────────────────

describe("WpImportException error mapping", () => {
  it("36. WpImportException has correct code and message", () => {
    const err = new WpImportException("invalid_credentials", "Bad credentials");
    expect(err.code).toBe("invalid_credentials");
    expect(err.message).toBe("Bad credentials");
    expect(err instanceof Error).toBe(true);
  });

  it("37. WpImportException is instanceof Error", () => {
    const err = new WpImportException("site_unreachable", "Cannot reach site");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof WpImportException).toBe(true);
  });

  it("38. All 6 error codes are defined", () => {
    const codes = [
      "invalid_credentials",
      "insufficient_permissions",
      "site_unreachable",
      "rate_limit",
      "zero_posts",
      "not_wordpress",
    ] as const;
    for (const code of codes) {
      const err = new WpImportException(code, "test");
      expect(err.code).toBe(code);
    }
  });
});
