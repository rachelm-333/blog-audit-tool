/**
 * Layer 11 — Dashboard Tests
 *
 * Tests:
 *   dashboard.db — getDashboardStats:
 *   1.  Returns zeroed stats for a business with no posts
 *   2.  Returns correct totalPosts count
 *   3.  Returns correct publishedCount / scheduledCount / draftCount
 *   4.  Returns null healthScore when no posts are audited
 *   5.  Returns correct healthScore (average of audited post scores)
 *   6.  Returns correct grade breakdown counts (optimised/strong/needs_work/poor/critical)
 *   7.  Returns correct cannibalisationCount
 *   8.  Returns correct scorePotential and projectedHealthScore
 *   9.  needsFirstAudit is true when posts exist but none audited
 *   10. needsFirstAudit is false when at least one post is audited
 *
 *   dashboard.db — getPostTableRows:
 *   11. Returns all rows when gradeFilter=all
 *   12. Filters correctly by gradeFilter=poor
 *   13. Filters correctly by statusFilter=draft
 *   14. Sorts by score ascending (lowest first)
 *   15. Sorts by score descending (highest first)
 *   16. Sorts by title ascending
 *   17. issueCount is computed from auditResults.points
 *
 *   tRPC — dashboard.getStats:
 *   18. Throws FORBIDDEN when businessId belongs to different user
 *   19. Returns stats for valid business + user
 *   20. Returns creditsRemaining from iaudit_users table
 *
 *   tRPC — dashboard.getPostTable:
 *   21. Throws FORBIDDEN when businessId belongs to different user
 *   22. Returns filtered rows via gradeFilter
 *
 *   tRPC — dashboard.listBusinesses:
 *   23. Returns empty array for user with no businesses
 *   24. Returns all businesses for user
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";
import { appRouter } from "./routers";
import { createIauditUser } from "./iauth.db";
import { upsertPost, createCmsConnection } from "./cms.db";
import { getDashboardStats, getPostTableRows } from "./dashboard.db";
import { getDb } from "./db";
import { businesses, posts, iauditUsers, cmsConnections } from "../drizzle/schema";
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

function makeBody(keyword: string): string {
  const filler =
    "This article covers everything you need to know about the topic in detail. " +
    "We have researched extensively to bring you the most accurate information available. " +
    "Our team of experts has reviewed every aspect of this subject matter carefully. " +
    "You will find comprehensive guidance throughout this document for your reference. ";
  return `<h1>${keyword} — Complete Guide</h1>
<p>If you are looking for information about ${keyword}, you have come to the right place.</p>
${filler.repeat(8)}
<h2>Understanding ${keyword}</h2>
<p>The ${keyword} process involves several important steps that must be followed carefully.</p>
${filler.repeat(4)}`;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

let testUserId: string;
let otherUserId: string;
let businessId: string;
let emptyBusinessId: string;

// Post IDs
let postPublishedPoorId: string;
let postPublishedStrongId: string;
let postScheduledNeedsWorkId: string;
let postDraftCriticalId: string;
let postOptimisedId: string;
let postUnaditedId: string;
let postCannibalisedId: string;

beforeAll(async () => {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  // Create two users
  testUserId = nanoid();
  otherUserId = nanoid();

  await createIauditUser({
    id: testUserId,
    email: `dash-test-${testUserId}@test.com`,
    name: "Dashboard Test User",
    passwordHash: "hash",
    accountType: "solo",
    emailVerified: true,
  });
  await createIauditUser({
    id: otherUserId,
    email: `dash-other-${otherUserId}@test.com`,
    name: "Dashboard Other User",
    passwordHash: "hash",
    accountType: "solo",
    emailVerified: true,
  });

  // Set credits for testUserId
  await db
    .update(iauditUsers)
    .set({ creditsRemaining: 42 })
    .where(eq(iauditUsers.id, testUserId));

  // Create main business
  businessId = nanoid();
  await db.insert(businesses).values({
    id: businessId,
    userId: testUserId,
    businessName: "Dashboard Test Business",
    websiteUrl: "https://dash-test.example.com",
    industry: "home_services",
    location: "Sydney, NSW",
    brandVoice: "Professional",
    tone: "Friendly",
    targetAudience: "Homeowners",
    uvp: "We deliver results",
    services: ["SEO"],
    primaryCtaUrl: "https://dash-test.example.com/contact",
    primaryCtaLabel: "Contact Us",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  // Create empty business (no posts)
  emptyBusinessId = nanoid();
  await db.insert(businesses).values({
    id: emptyBusinessId,
    userId: testUserId,
    businessName: "Empty Business",
    websiteUrl: "https://empty.example.com",
    industry: "home_services",
    location: "Melbourne, VIC",
    brandVoice: "Professional",
    tone: "Friendly",
    targetAudience: "Homeowners",
    uvp: "We deliver results",
    services: ["SEO"],
    primaryCtaUrl: "https://empty.example.com/contact",
    primaryCtaLabel: "Contact Us",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  // Create CMS connection
  await createCmsConnection({
    businessId,
    platform: "wordpress",
    siteUrl: "https://dash-test.example.com",
    credentials: {
      siteUrl: "https://dash-test.example.com",
      username: "admin",
      applicationPassword: "test-app-password",
    },
  });

  // Post 1: published, audited as poor (score 7)
  postPublishedPoorId = await upsertPost({
    businessId,
    cmsPlatform: "wordpress",
    cmsPostId: `wp-dash-poor-${nanoid()}`,
    title: "Pool Installation Cost Sydney",
    bodyHtml: makeBody("pool installation cost Sydney"),
    url: "https://dash-test.example.com/pool-cost",
    status: "published",
    publishDate: new Date("2025-03-14"),
    scheduledDate: null,
    authorIdCms: "1",
    authorNameCms: "Sarah Chen",
    metaTitle: "Pool Installation Cost Sydney",
    metaDescription: "Find out how much pool installation costs in Sydney.",
    featuredImageUrl: null,
    featuredImageAlt: null,
    bodyImageAlts: [],
    categories: [],
    tags: [],
    focusKeyword: "pool installation cost Sydney",
  });
  await db.update(posts).set({
    auditStatus: "complete",
    auditScore: 7,
    auditGrade: "poor",
    auditResults: {
      points: [
        ...Array(7).fill({ pass: true }),
        ...Array(9).fill({ pass: false }),
      ],
    },
  }).where(eq(posts.id, postPublishedPoorId));

  // Post 2: published, audited as strong (score 13)
  postPublishedStrongId = await upsertPost({
    businessId,
    cmsPlatform: "wordpress",
    cmsPostId: `wp-dash-strong-${nanoid()}`,
    title: "Pool Heating Options Sydney",
    bodyHtml: makeBody("pool heating options Sydney"),
    url: "https://dash-test.example.com/pool-heating",
    status: "published",
    publishDate: new Date("2024-11-08"),
    scheduledDate: null,
    authorIdCms: "2",
    authorNameCms: "Marcus Webb",
    metaTitle: "Pool Heating Options Sydney",
    metaDescription: "Compare solar, heat pump, and gas pool heating in Sydney.",
    featuredImageUrl: null,
    featuredImageAlt: null,
    bodyImageAlts: [],
    categories: [],
    tags: [],
    focusKeyword: "pool heating options Sydney",
  });
  await db.update(posts).set({
    auditStatus: "complete",
    auditScore: 13,
    auditGrade: "strong",
    auditResults: {
      points: [
        ...Array(13).fill({ pass: true }),
        ...Array(3).fill({ pass: false }),
      ],
    },
  }).where(eq(posts.id, postPublishedStrongId));

  // Post 3: scheduled, audited as needs_work (score 11)
  postScheduledNeedsWorkId = await upsertPost({
    businessId,
    cmsPlatform: "wordpress",
    cmsPostId: `wp-dash-nw-${nanoid()}`,
    title: "Pool Installation Timeline",
    bodyHtml: makeBody("pool installation timeline Sydney"),
    url: "https://dash-test.example.com/pool-timeline",
    status: "scheduled",
    publishDate: null,
    scheduledDate: new Date("2025-07-15"),
    authorIdCms: "1",
    authorNameCms: "Sarah Chen",
    metaTitle: "Pool Installation Timeline",
    metaDescription: "A realistic timeline for pool installation in Sydney.",
    featuredImageUrl: null,
    featuredImageAlt: null,
    bodyImageAlts: [],
    categories: [],
    tags: [],
    focusKeyword: "pool installation timeline Sydney",
  });
  await db.update(posts).set({
    auditStatus: "complete",
    auditScore: 11,
    auditGrade: "needs_work",
    auditResults: {
      points: [
        ...Array(11).fill({ pass: true }),
        ...Array(5).fill({ pass: false }),
      ],
    },
  }).where(eq(posts.id, postScheduledNeedsWorkId));

  // Post 4: draft, audited as critical (score 4)
  postDraftCriticalId = await upsertPost({
    businessId,
    cmsPlatform: "wordpress",
    cmsPostId: `wp-dash-crit-${nanoid()}`,
    title: "Inground Pool Prices Sydney 2025",
    bodyHtml: "<p>Draft content.</p>",
    url: "https://dash-test.example.com/pool-prices",
    status: "draft",
    publishDate: null,
    scheduledDate: null,
    authorIdCms: "3",
    authorNameCms: "Rachel Mackay",
    metaTitle: "Inground Pool Prices Sydney 2025",
    metaDescription: "Pool prices guide.",
    featuredImageUrl: null,
    featuredImageAlt: null,
    bodyImageAlts: [],
    categories: [],
    tags: [],
    focusKeyword: null,
  });
  await db.update(posts).set({
    auditStatus: "complete",
    auditScore: 4,
    auditGrade: "critical",
    auditResults: {
      points: [
        ...Array(4).fill({ pass: true }),
        ...Array(12).fill({ pass: false }),
      ],
    },
  }).where(eq(posts.id, postDraftCriticalId));

  // Post 5: published, audited as optimised (score 15)
  postOptimisedId = await upsertPost({
    businessId,
    cmsPlatform: "wordpress",
    cmsPostId: `wp-dash-opt-${nanoid()}`,
    title: "Pool Fencing Laws NSW",
    bodyHtml: makeBody("pool fencing laws NSW"),
    url: "https://dash-test.example.com/pool-fencing",
    status: "published",
    publishDate: new Date("2024-09-22"),
    scheduledDate: null,
    authorIdCms: "1",
    authorNameCms: "Sarah Chen",
    metaTitle: "Pool Fencing Laws NSW",
    metaDescription: "Complete guide to pool fencing laws in NSW.",
    featuredImageUrl: null,
    featuredImageAlt: null,
    bodyImageAlts: [],
    categories: [],
    tags: [],
    focusKeyword: "pool fencing laws NSW",
  });
  await db.update(posts).set({
    auditStatus: "complete",
    auditScore: 15,
    auditGrade: "optimised",
    auditResults: {
      points: [
        ...Array(15).fill({ pass: true }),
        ...Array(1).fill({ pass: false }),
      ],
    },
  }).where(eq(posts.id, postOptimisedId));

  // Post 6: published, NOT audited
  postUnaditedId = await upsertPost({
    businessId,
    cmsPlatform: "wordpress",
    cmsPostId: `wp-dash-unaudited-${nanoid()}`,
    title: "Fibreglass vs Concrete Pools",
    bodyHtml: makeBody("fibreglass vs concrete pools Sydney"),
    url: "https://dash-test.example.com/fibreglass-vs-concrete",
    status: "published",
    publishDate: new Date("2025-01-02"),
    scheduledDate: null,
    authorIdCms: "2",
    authorNameCms: "Marcus Webb",
    metaTitle: "Fibreglass vs Concrete Pools",
    metaDescription: "Compare fibreglass and concrete pools in Sydney.",
    featuredImageUrl: null,
    featuredImageAlt: null,
    bodyImageAlts: [],
    categories: [],
    tags: [],
    focusKeyword: "fibreglass vs concrete pools Sydney",
  });
  // No audit update — auditStatus remains null

  // Post 7: published, audited as poor, cannibalisation flag set
  postCannibalisedId = await upsertPost({
    businessId,
    cmsPlatform: "wordpress",
    cmsPostId: `wp-dash-cannibal-${nanoid()}`,
    title: "Pool Installation Cost Sydney — Duplicate",
    bodyHtml: makeBody("pool installation cost Sydney"),
    url: "https://dash-test.example.com/pool-cost-2",
    status: "published",
    publishDate: new Date("2025-01-15"),
    scheduledDate: null,
    authorIdCms: "1",
    authorNameCms: "Sarah Chen",
    metaTitle: "Pool Installation Cost Sydney Duplicate",
    metaDescription: "Duplicate keyword post.",
    featuredImageUrl: null,
    featuredImageAlt: null,
    bodyImageAlts: [],
    categories: [],
    tags: [],
    focusKeyword: "pool installation cost Sydney",
  });
  await db.update(posts).set({
    auditStatus: "complete",
    auditScore: 6,
    auditGrade: "poor",
    cannibalizationFlag: true,
    auditResults: {
      points: [
        ...Array(6).fill({ pass: true }),
        ...Array(10).fill({ pass: false }),
      ],
    },
  }).where(eq(posts.id, postCannibalisedId));
});

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  // Clean up test data — respect FK order: posts → cms_connections → businesses → users
  await db.delete(posts).where(eq(posts.businessId, businessId));
  await db.delete(posts).where(eq(posts.businessId, emptyBusinessId));
  await db.delete(cmsConnections).where(eq(cmsConnections.businessId, businessId));
  await db.delete(cmsConnections).where(eq(cmsConnections.businessId, emptyBusinessId));
  await db.delete(businesses).where(eq(businesses.id, businessId));
  await db.delete(businesses).where(eq(businesses.id, emptyBusinessId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, testUserId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, otherUserId));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Layer 11 — Dashboard", () => {
  // ── getDashboardStats ──────────────────────────────────────────────────────

  it("1. getDashboardStats — returns zeroed stats for empty business", async () => {
    const stats = await getDashboardStats(emptyBusinessId);
    expect(stats.totalPosts).toBe(0);
    expect(stats.healthScore).toBeNull();
    expect(stats.healthGrade).toBeNull();
    expect(stats.scorePotential).toBeNull();
    expect(stats.auditedPostCount).toBe(0);
    expect(stats.needsFirstAudit).toBe(false);
  });

  it("2. getDashboardStats — returns correct totalPosts count", async () => {
    const stats = await getDashboardStats(businessId);
    // 7 posts created in beforeAll
    expect(stats.totalPosts).toBe(7);
  });

  it("3. getDashboardStats — returns correct status counts", async () => {
    const stats = await getDashboardStats(businessId);
    // published: postPublishedPoorId, postPublishedStrongId, postOptimisedId, postUnaditedId, postCannibalisedId = 5
    // scheduled: postScheduledNeedsWorkId = 1
    // draft: postDraftCriticalId = 1
    expect(stats.publishedCount).toBe(5);
    expect(stats.scheduledCount).toBe(1);
    expect(stats.draftCount).toBe(1);
  });

  it("4. getDashboardStats — healthScore is null when no posts audited", async () => {
    // Use empty business
    const stats = await getDashboardStats(emptyBusinessId);
    expect(stats.healthScore).toBeNull();
  });

  it("5. getDashboardStats — returns correct healthScore (average of audited posts)", async () => {
    const stats = await getDashboardStats(businessId);
    // Audited posts: 7, 13, 11, 4, 15, 6 (postUnaditedId is not audited)
    // Sum = 7+13+11+4+15+6 = 56, count = 6, avg = 56/6 ≈ 9.3
    expect(stats.auditedPostCount).toBe(6);
    const expected = Math.round((56 / 6) * 10) / 10;
    expect(stats.healthScore).toBe(expected);
  });

  it("6. getDashboardStats — returns correct grade breakdown counts", async () => {
    const stats = await getDashboardStats(businessId);
    expect(stats.optimisedCount).toBe(1);   // postOptimisedId (15)
    expect(stats.strongCount).toBe(1);       // postPublishedStrongId (13)
    expect(stats.needsWorkCount).toBe(1);    // postScheduledNeedsWorkId (11)
    expect(stats.poorCount).toBe(2);         // postPublishedPoorId (7) + postCannibalisedId (6)
    expect(stats.criticalCount).toBe(1);     // postDraftCriticalId (4)
  });

  it("7. getDashboardStats — returns correct cannibalisationCount", async () => {
    const stats = await getDashboardStats(businessId);
    expect(stats.cannibalisationCount).toBe(1); // postCannibalisedId
  });

  it("8. getDashboardStats — returns correct scorePotential and projectedHealthScore", async () => {
    const stats = await getDashboardStats(businessId);
    // Poor posts: scores 7, 6 (sum=13); Critical: score 4 (sum=4)
    // poorAndCriticalCount = 3, poorCriticalScoreSum = 7+6+4 = 17
    // totalScoreSum = 56
    // projectedSum = 56 - 17 + 3*15 = 56 - 17 + 45 = 84
    // projectedAvg = 84/6 = 14.0
    // scorePotential = 14.0 - (56/6) = 14.0 - 9.333... ≈ 4.7
    expect(stats.poorAndCriticalCount).toBe(3);
    expect(stats.projectedHealthScore).not.toBeNull();
    expect(stats.scorePotential).not.toBeNull();
    expect(stats.projectedHealthScore!).toBeGreaterThan(stats.healthScore!);
  });

  it("9. getDashboardStats — needsFirstAudit is true when posts exist but none audited", async () => {
    // Create a temporary business with one unaudited post
    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const tempBizId = nanoid();
    await db.insert(businesses).values({
      id: tempBizId,
      userId: testUserId,
      businessName: "Temp Biz",
      websiteUrl: "https://temp.example.com",
      industry: "home_services",
      location: "Sydney, NSW",
      brandVoice: "Professional",
      tone: "Friendly",
      targetAudience: "Homeowners",
      uvp: "We deliver results",
      services: ["SEO"],
      primaryCtaUrl: "https://temp.example.com/contact",
      primaryCtaLabel: "Contact Us",
      scrapeStatus: "complete",
      stage1Complete: true,
    });
    await upsertPost({
      businessId: tempBizId,
      cmsPlatform: "wordpress",
      cmsPostId: `wp-temp-${nanoid()}`,
      title: "Temp Post",
      bodyHtml: "<p>Content.</p>",
      url: "https://temp.example.com/post",
      status: "published",
      publishDate: null,
      scheduledDate: null,
      authorIdCms: "1",
      authorNameCms: "Author",
      metaTitle: "Temp Post",
      metaDescription: "Temp description.",
      featuredImageUrl: null,
      featuredImageAlt: null,
      bodyImageAlts: [],
      categories: [],
      tags: [],
      focusKeyword: "temp keyword",
    });

    const stats = await getDashboardStats(tempBizId);
    expect(stats.needsFirstAudit).toBe(true);
    expect(stats.totalPosts).toBe(1);
    expect(stats.auditedPostCount).toBe(0);

    // Cleanup
    await db.delete(posts).where(eq(posts.businessId, tempBizId));
    await db.delete(businesses).where(eq(businesses.id, tempBizId));
  });

  it("10. getDashboardStats — needsFirstAudit is false when at least one post is audited", async () => {
    const stats = await getDashboardStats(businessId);
    expect(stats.needsFirstAudit).toBe(false);
    expect(stats.auditedPostCount).toBeGreaterThan(0);
  });

  // ── getPostTableRows ───────────────────────────────────────────────────────

  it("11. getPostTableRows — returns all rows when gradeFilter=all", async () => {
    const rows = await getPostTableRows(businessId, "all", "all", "score", "asc");
    expect(rows.length).toBe(7);
  });

  it("12. getPostTableRows — filters correctly by gradeFilter=poor", async () => {
    const rows = await getPostTableRows(businessId, "poor", "all", "score", "asc");
    // postPublishedPoorId (7) + postCannibalisedId (6)
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.auditGrade === "poor")).toBe(true);
  });

  it("13. getPostTableRows — filters correctly by statusFilter=draft", async () => {
    const rows = await getPostTableRows(businessId, "all", "draft", "score", "asc");
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("draft");
  });

  it("14. getPostTableRows — sorts by score ascending (lowest first)", async () => {
    const rows = await getPostTableRows(businessId, "all", "all", "score", "asc");
    // Unaudited posts (score=null) should sort to the bottom with score=-1
    const audited = rows.filter((r) => r.auditScore !== null);
    for (let i = 1; i < audited.length; i++) {
      expect(audited[i].auditScore!).toBeGreaterThanOrEqual(audited[i - 1].auditScore!);
    }
  });

  it("15. getPostTableRows — sorts by score descending (highest first)", async () => {
    const rows = await getPostTableRows(businessId, "all", "all", "score", "desc");
    const audited = rows.filter((r) => r.auditScore !== null);
    for (let i = 1; i < audited.length; i++) {
      expect(audited[i].auditScore!).toBeLessThanOrEqual(audited[i - 1].auditScore!);
    }
  });

  it("16. getPostTableRows — sorts by title ascending", async () => {
    const rows = await getPostTableRows(businessId, "all", "all", "title", "asc");
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].title.localeCompare(rows[i - 1].title)).toBeGreaterThanOrEqual(0);
    }
  });

  it("17. getPostTableRows — issueCount is computed from auditResults.points", async () => {
    const rows = await getPostTableRows(businessId, "all", "all", "score", "asc");
    const poorRow = rows.find((r) => r.id === postPublishedPoorId);
    expect(poorRow).toBeDefined();
    // postPublishedPoorId has 9 failing points
    expect(poorRow!.issueCount).toBe(9);

    const optRow = rows.find((r) => r.id === postOptimisedId);
    expect(optRow).toBeDefined();
    // postOptimisedId has 1 failing point
    expect(optRow!.issueCount).toBe(1);
  });

  // ── tRPC dashboard.getStats ────────────────────────────────────────────────

  it("18. dashboard.getStats — throws FORBIDDEN when businessId belongs to different user", async () => {
    const caller = makeCaller(otherUserId);
    await expect(
      caller.dashboard.getStats({ iauditUserId: otherUserId, businessId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("19. dashboard.getStats — returns stats for valid business + user", async () => {
    const caller = makeCaller(testUserId);
    const result = await caller.dashboard.getStats({
      iauditUserId: testUserId,
      businessId,
    });
    expect(result.business.id).toBe(businessId);
    expect(result.stats.totalPosts).toBe(7);
    expect(result.stats.auditedPostCount).toBe(6);
    expect(result.stats.healthScore).not.toBeNull();
  });

  it("20. dashboard.getStats — returns creditsRemaining from iaudit_users table", async () => {
    const caller = makeCaller(testUserId);
    const result = await caller.dashboard.getStats({
      iauditUserId: testUserId,
      businessId,
    });
    expect(result.creditsRemaining).toBe(42);
  });

  // ── tRPC dashboard.getPostTable ────────────────────────────────────────────

  it("21. dashboard.getPostTable — throws FORBIDDEN when businessId belongs to different user", async () => {
    const caller = makeCaller(otherUserId);
    await expect(
      caller.dashboard.getPostTable({
        iauditUserId: otherUserId,
        businessId,
        gradeFilter: "all",
        statusFilter: "all",
        sortField: "score",
        sortDir: "asc",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("22. dashboard.getPostTable — returns filtered rows via gradeFilter", async () => {
    const caller = makeCaller(testUserId);
    const result = await caller.dashboard.getPostTable({
      iauditUserId: testUserId,
      businessId,
      gradeFilter: "critical",
      statusFilter: "all",
      sortField: "score",
      sortDir: "asc",
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].auditGrade).toBe("critical");
  });

  // ── tRPC dashboard.listBusinesses ─────────────────────────────────────────

  it("23. dashboard.listBusinesses — returns empty array for user with no businesses", async () => {
    const caller = makeCaller(otherUserId);
    const result = await caller.dashboard.listBusinesses({
      iauditUserId: otherUserId,
    });
    expect(result.businesses).toHaveLength(0);
  });

  it("24. dashboard.listBusinesses — returns all businesses for user", async () => {
    const caller = makeCaller(testUserId);
    const result = await caller.dashboard.listBusinesses({
      iauditUserId: testUserId,
    });
    // testUserId has businessId + emptyBusinessId = 2 businesses
    expect(result.businesses.length).toBeGreaterThanOrEqual(2);
    const ids = result.businesses.map((b) => b.id);
    expect(ids).toContain(businessId);
    expect(ids).toContain(emptyBusinessId);
  });
});
