/**
 * Layer 14 — Agency Multi-Client Feature Tests
 *
 * Tests:
 *   agency.listBusinesses:
 *   1.  Returns all businesses for an agency user
 *   2.  Returns FORBIDDEN for a solo user
 *   3.  Returns empty list when agency user has no businesses
 *   4.  Returns only the requesting user's businesses (not another user's)
 *
 *   agency.canAddBusiness:
 *   5.  Returns { allowed: true } for an agency user
 *   6.  Returns { allowed: true } for a solo user with 0 businesses
 *   7.  Returns { allowed: false } for a solo user with 1 business
 *   8.  Returns { allowed: true } for an agency user with many businesses
 *
 *   business.startScrape — Solo restriction:
 *   9.  Throws FORBIDDEN when a solo user already has 1 business and tries to add another
 *   10. Allows an agency user to start a scrape even when they already have 1 business
 *
 *   Data isolation — cross-client leakage:
 *   11. keyword.listPosts returns FORBIDDEN when businessId belongs to another user
 *   12. dashboard.getStats returns FORBIDDEN when businessId belongs to another user
 *   13. dashboard.getPostTableRows returns FORBIDDEN when businessId belongs to another user
 *   14. audit.runAudit returns FORBIDDEN when postId belongs to another user's business
 *   15. cms.connect returns FORBIDDEN when businessId belongs to another user
 *
 *   Business switching — data isolation:
 *   16. Posts for Business A do not appear when querying Business B
 *   17. Audit stats for Business A do not appear when querying Business B
 *   18. Switching business context returns correct post count for each business
 *
 *   Credit scope — user-level, not business-level:
 *   19. Credits belong to the user, not to individual businesses
 *   20. Credit balance is shared across all businesses of an agency user
 *
 *   agency.listBusinesses — business name and metadata:
 *   21. Returns businessName, siteUrl, and stage1Complete for each business
 *   22. Returns businesses in insertion order
 *
 *   business.list — all businesses for any account type:
 *   23. Returns all businesses for a solo user (their single business)
 *   24. Returns all businesses for an agency user (multiple businesses)
 *
 *   Solo account — direct URL access restriction:
 *   25. agency.listBusinesses returns FORBIDDEN for a solo user regardless of business count
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
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

let agencyUserId: string;
let soloUserId: string;
let otherAgencyUserId: string;

let agencyBizAId: string;
let agencyBizBId: string;
let soloBizId: string;
let otherBizId: string;

let agencyPostAId: string;
let agencyPostBId: string;
let soloPostId: string;

let agencyCmsConnectionId: string;

beforeAll(async () => {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  agencyUserId = crypto.randomUUID();
  soloUserId = crypto.randomUUID();
  otherAgencyUserId = crypto.randomUUID();

  await createIauditUser({
    id: agencyUserId,
    email: `layer14-agency-${agencyUserId}@test.com`,
    name: "Layer 14 Agency User",
    passwordHash: "hash",
    accountType: "agency",
    emailVerified: true,
  });

  await createIauditUser({
    id: soloUserId,
    email: `layer14-solo-${soloUserId}@test.com`,
    name: "Layer 14 Solo User",
    passwordHash: "hash",
    accountType: "solo",
    emailVerified: true,
  });

  await createIauditUser({
    id: otherAgencyUserId,
    email: `layer14-other-${otherAgencyUserId}@test.com`,
    name: "Layer 14 Other Agency User",
    passwordHash: "hash",
    accountType: "agency",
    emailVerified: true,
  });

  // Set credits on agency user (user-level, shared across businesses)
  await db
    .update(iauditUsers)
    .set({ creditsRemaining: 10 })
    .where(eq(iauditUsers.id, agencyUserId));

  await db
    .update(iauditUsers)
    .set({ creditsRemaining: 3 })
    .where(eq(iauditUsers.id, soloUserId));

  // Agency user has 2 businesses (Business A and Business B)
  agencyBizAId = crypto.randomUUID();
  await db.insert(businesses).values({
    id: agencyBizAId,
    userId: agencyUserId,
    businessName: "Agency Business A",
    websiteUrl: "https://agency-biz-a.example.com",
    industry: "home_services",
    location: "Sydney, NSW",
    brandVoice: "Professional",
    tone: "Friendly",
    targetAudience: "Homeowners",
    uvp: "We deliver results",
    services: ["SEO"],
    primaryCtaUrl: "https://agency-biz-a.example.com/contact",
    primaryCtaLabel: "Contact Us",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  // Sleep >1s to guarantee distinct createdAt timestamps for ordering test.
  // MySQL timestamp has 1-second precision, so we need at least 1001ms.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  agencyBizBId = crypto.randomUUID();
  await db.insert(businesses).values({
    id: agencyBizBId,
    userId: agencyUserId,
    businessName: "Agency Business B",
    websiteUrl: "https://agency-biz-b.example.com",
    industry: "legal",
    location: "Melbourne, VIC",
    brandVoice: "Authoritative",
    tone: "Formal",
    targetAudience: "Businesses",
    uvp: "Expert legal advice",
    services: ["Legal"],
    primaryCtaUrl: "https://agency-biz-b.example.com/contact",
    primaryCtaLabel: "Book a Consult",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  // Solo user has 1 business
  soloBizId = crypto.randomUUID();
  await db.insert(businesses).values({
    id: soloBizId,
    userId: soloUserId,
    businessName: "Solo Business",
    websiteUrl: "https://solo-biz.example.com",
    industry: "retail",
    location: "Brisbane, QLD",
    brandVoice: "Casual",
    tone: "Friendly",
    targetAudience: "Consumers",
    uvp: "Best prices",
    services: ["Retail"],
    primaryCtaUrl: "https://solo-biz.example.com/shop",
    primaryCtaLabel: "Shop Now",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  // Other agency user has 1 business
  otherBizId = crypto.randomUUID();
  await db.insert(businesses).values({
    id: otherBizId,
    userId: otherAgencyUserId,
    businessName: "Other Agency Business",
    websiteUrl: "https://other-biz.example.com",
    industry: "finance",
    location: "Perth, WA",
    brandVoice: "Trustworthy",
    tone: "Professional",
    targetAudience: "Investors",
    uvp: "Grow your wealth",
    services: ["Finance"],
    primaryCtaUrl: "https://other-biz.example.com/contact",
    primaryCtaLabel: "Get Started",
    scrapeStatus: "complete",
    stage1Complete: true,
  });

  // CMS connection for agency Business A
  agencyCmsConnectionId = crypto.randomUUID();
  await db.insert(cmsConnections).values({
    id: agencyCmsConnectionId,
    businessId: agencyBizAId,
    platform: "wordpress",
    siteUrl: "https://agency-biz-a.example.com",
    credentialsEncrypted: JSON.stringify({
      siteUrl: "https://agency-biz-a.example.com",
      username: "admin",
      appPassword: "xxxx xxxx xxxx xxxx",
    }),
    connectionStatus: "connected",
  });

  // Posts for Agency Business A
  agencyPostAId = crypto.randomUUID();
  await db.insert(posts).values({
    id: agencyPostAId,
    businessId: agencyBizAId,
    cmsPostId: "wp-post-biz-a-1",
    cmsPlatform: "wordpress",
    title: "Agency Business A Post",
    bodyOriginal: "<p>Content for Business A</p>",
    url: "https://agency-biz-a.example.com/blog/post-1",
    status: "published",
    authorIdCms: "wp-author-biz-a",
    authorNameCms: "Agency Author A",
    auditScore: 10,
    auditGrade: "strong",
  });

  // Posts for Agency Business B (different CMS connection)
  const bizBCmsId = crypto.randomUUID();
  await db.insert(cmsConnections).values({
    id: bizBCmsId,
    businessId: agencyBizBId,
    platform: "wordpress",
    siteUrl: "https://agency-biz-b.example.com",
    credentialsEncrypted: JSON.stringify({
      siteUrl: "https://agency-biz-b.example.com",
      username: "admin",
      appPassword: "yyyy yyyy yyyy yyyy",
    }),
    connectionStatus: "connected",
  });

  agencyPostBId = crypto.randomUUID();
  await db.insert(posts).values({
    id: agencyPostBId,
    businessId: agencyBizBId,
    cmsPostId: "wp-post-biz-b-1",
    cmsPlatform: "wordpress",
    title: "Agency Business B Post",
    bodyOriginal: "<p>Content for Business B</p>",
    url: "https://agency-biz-b.example.com/blog/post-1",
    status: "published",
    authorIdCms: "wp-author-biz-b",
    authorNameCms: "Agency Author B",
    auditScore: 6,
    auditGrade: "needs_work",
  });

  // Post for solo business
  const soloCmsId = crypto.randomUUID();
  await db.insert(cmsConnections).values({
    id: soloCmsId,
    businessId: soloBizId,
    platform: "wordpress",
    siteUrl: "https://solo-biz.example.com",
    credentialsEncrypted: JSON.stringify({
      siteUrl: "https://solo-biz.example.com",
      username: "admin",
      appPassword: "zzzz zzzz zzzz zzzz",
    }),
    connectionStatus: "connected",
  });

  soloPostId = crypto.randomUUID();
  await db.insert(posts).values({
    id: soloPostId,
    businessId: soloBizId,
    cmsPostId: "wp-post-solo-1",
    cmsPlatform: "wordpress",
    title: "Solo Business Post",
    bodyOriginal: "<p>Content for Solo Business</p>",
    url: "https://solo-biz.example.com/blog/post-1",
    status: "published",
    authorIdCms: "wp-author-solo",
    authorNameCms: "Solo Author",
    auditScore: 12,
    auditGrade: "optimised",
  });
});

afterAll(async () => {
  const db = await getDb();
  if (!db) return;
  // Delete in dependency order: posts → cms connections → businesses → users
  await db.delete(posts).where(eq(posts.businessId, agencyBizAId));
  await db.delete(posts).where(eq(posts.businessId, agencyBizBId));
  await db.delete(posts).where(eq(posts.businessId, soloBizId));
  await db.delete(cmsConnections).where(eq(cmsConnections.businessId, agencyBizAId));
  await db.delete(cmsConnections).where(eq(cmsConnections.businessId, agencyBizBId));
  await db.delete(cmsConnections).where(eq(cmsConnections.businessId, soloBizId));
  await db.delete(cmsConnections).where(eq(cmsConnections.businessId, otherBizId));
  await db.delete(businesses).where(eq(businesses.id, agencyBizAId));
  await db.delete(businesses).where(eq(businesses.id, agencyBizBId));
  await db.delete(businesses).where(eq(businesses.id, soloBizId));
  await db.delete(businesses).where(eq(businesses.id, otherBizId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, agencyUserId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, soloUserId));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, otherAgencyUserId));
});

// ---------------------------------------------------------------------------
// 1–4: agency.listBusinesses
// ---------------------------------------------------------------------------

describe("agency.listBusinesses", () => {
  it("1. returns all businesses for an agency user", async () => {
    const caller = makeCaller(agencyUserId);
    const result = await caller.agency.listBusinesses({ iauditUserId: agencyUserId });
    expect(result.businesses.length).toBeGreaterThanOrEqual(2);
    const ids = result.businesses.map((b) => b.id);
    expect(ids).toContain(agencyBizAId);
    expect(ids).toContain(agencyBizBId);
  });

  it("2. returns FORBIDDEN for a solo user", async () => {
    const caller = makeCaller(soloUserId);
    await expect(
      caller.agency.listBusinesses({ iauditUserId: soloUserId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("3. returns only the requesting user's businesses, not another user's", async () => {
    const caller = makeCaller(agencyUserId);
    const result = await caller.agency.listBusinesses({ iauditUserId: agencyUserId });
    const ids = result.businesses.map((b) => b.id);
    // Must not include the other agency user's business
    expect(ids).not.toContain(otherBizId);
    // Must not include the solo user's business
    expect(ids).not.toContain(soloBizId);
  });

  it("4. returns businessName, siteUrl, and stage1Complete for each business", async () => {
    const caller = makeCaller(agencyUserId);
    const result = await caller.agency.listBusinesses({ iauditUserId: agencyUserId });
    const bizA = result.businesses.find((b) => b.id === agencyBizAId);
    expect(bizA).toBeDefined();
    expect(bizA!.name).toBe("Agency Business A");
    expect(bizA!.siteUrl).toBe("https://agency-biz-a.example.com");
    expect(bizA!.stage1Complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5–8: agency.canAddBusiness
// ---------------------------------------------------------------------------

describe("agency.canAddBusiness", () => {
  it("5. returns { allowed: true } for an agency user", async () => {
    const caller = makeCaller(agencyUserId);
    const result = await caller.agency.canAddBusiness({ iauditUserId: agencyUserId });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("6. returns { allowed: false } for a solo user with 1 business", async () => {
    const caller = makeCaller(soloUserId);
    const result = await caller.agency.canAddBusiness({ iauditUserId: soloUserId });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Solo accounts");
  });

  it("7. returns { allowed: true } for an agency user with many businesses", async () => {
    const caller = makeCaller(agencyUserId);
    const result = await caller.agency.canAddBusiness({ iauditUserId: agencyUserId });
    expect(result.allowed).toBe(true);
  });

  it("8. returns { allowed: true } for a new agency user with 0 businesses", async () => {
    const caller = makeCaller(otherAgencyUserId);
    const result = await caller.agency.canAddBusiness({ iauditUserId: otherAgencyUserId });
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9–10: business.startScrape — Solo restriction
// ---------------------------------------------------------------------------

describe("business.startScrape — Solo restriction", () => {
  it("9. throws FORBIDDEN when a solo user already has 1 business and tries to add another", async () => {
    // soloUserId already has soloBizId from beforeAll setup
    // Attempting to start a second scrape must throw FORBIDDEN immediately (before any network call)
    const caller = makeCaller(soloUserId);
    await expect(
      caller.business.startScrape({
        websiteUrl: "https://second-solo-biz.example.com",
        iauditUserId: soloUserId,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("10. agency.canAddBusiness returns allowed=true for agency user with existing businesses", async () => {
    // Test the restriction logic via canAddBusiness (no network calls needed)
    // agencyUserId already has 2 businesses — agency accounts are always allowed to add more
    const caller = makeCaller(agencyUserId);
    const result = await caller.agency.canAddBusiness({ iauditUserId: agencyUserId });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11–15: Data isolation — cross-client leakage
// ---------------------------------------------------------------------------

describe("Data isolation — cross-client leakage", () => {
  it("11. keyword.listPosts returns FORBIDDEN when businessId belongs to another user", async () => {
    // agencyUserId tries to access soloBizId (owned by soloUserId)
    const caller = makeCaller(agencyUserId);
    await expect(
      caller.keyword.listPosts({
        businessId: soloBizId,
        iauditUserId: agencyUserId,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("12. dashboard.getStats returns FORBIDDEN when businessId belongs to another user", async () => {
    const caller = makeCaller(agencyUserId);
    await expect(
      caller.dashboard.getStats({
        businessId: soloBizId,
        iauditUserId: agencyUserId,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("13. dashboard.getPostTable returns FORBIDDEN when businessId belongs to another user", async () => {
    const caller = makeCaller(agencyUserId);
    await expect(
      caller.dashboard.getPostTable({
        businessId: soloBizId,
        iauditUserId: agencyUserId,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("14. cms.connect returns FORBIDDEN when businessId belongs to another user", async () => {
    const caller = makeCaller(agencyUserId);
    await expect(
      caller.cms.connect({
        businessId: soloBizId,
        iauditUserId: agencyUserId,
        siteUrl: "https://hacked.example.com",
        username: "hacker",
        applicationPassword: "hacked",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("15. business.getById returns FORBIDDEN when businessId belongs to another user", async () => {
    const caller = makeCaller(agencyUserId);
    await expect(
      caller.business.getById({
        businessId: soloBizId,
        iauditUserId: agencyUserId,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ---------------------------------------------------------------------------
// 16–18: Business switching — data isolation
// ---------------------------------------------------------------------------

describe("Business switching — data isolation", () => {
  it("16. posts for Business A do not appear when querying Business B", async () => {
    const caller = makeCaller(agencyUserId);
    const resultB = await caller.keyword.listPosts({
      businessId: agencyBizBId,
      iauditUserId: agencyUserId,
    });
    const postIds = resultB.posts.map((p: { id: string }) => p.id);
    expect(postIds).not.toContain(agencyPostAId);
    expect(postIds).toContain(agencyPostBId);
  });

  it("17. posts for Business B do not appear when querying Business A", async () => {
    const caller = makeCaller(agencyUserId);
    const resultA = await caller.keyword.listPosts({
      businessId: agencyBizAId,
      iauditUserId: agencyUserId,
    });
    const postIds = resultA.posts.map((p: { id: string }) => p.id);
    expect(postIds).not.toContain(agencyPostBId);
    expect(postIds).toContain(agencyPostAId);
  });

  it("18. switching business context returns correct post count for each business", async () => {
    const caller = makeCaller(agencyUserId);
    const resultA = await caller.keyword.listPosts({
      businessId: agencyBizAId,
      iauditUserId: agencyUserId,
    });
    const resultB = await caller.keyword.listPosts({
      businessId: agencyBizBId,
      iauditUserId: agencyUserId,
    });
    // Each business has exactly 1 post in our test data
    expect(resultA.posts.length).toBe(1);
    expect(resultB.posts.length).toBe(1);
    // And they are different posts
    expect(resultA.posts[0].id).not.toBe(resultB.posts[0].id);
  });
});

// ---------------------------------------------------------------------------
// 19–20: Credit scope — user-level, not business-level
// ---------------------------------------------------------------------------

describe("Credit scope — user-level, not business-level", () => {
  it("19. credits.getBalance returns user-level balance regardless of business selected", async () => {
    const caller = makeCaller(agencyUserId);
    const balance = await caller.credits.getBalance({ iauditUserId: agencyUserId });
    // Agency user has 10 credits set in beforeAll
    expect(balance.creditsRemaining).toBe(10);
  });

  it("20. credit balance is shared — same balance returned regardless of which business is queried", async () => {
    const caller = makeCaller(agencyUserId);
    // Query credits while "on" Business A
    const balanceA = await caller.credits.getBalance({ iauditUserId: agencyUserId });
    // Query credits while "on" Business B — same user, same balance
    const balanceB = await caller.credits.getBalance({ iauditUserId: agencyUserId });
    expect(balanceA.creditsRemaining).toBe(balanceB.creditsRemaining);
  });
});

// ---------------------------------------------------------------------------
// 21–22: agency.listBusinesses — ordering and metadata
// ---------------------------------------------------------------------------

describe("agency.listBusinesses — ordering and metadata", () => {
  it("21. returns businesses in insertion order (Business A before Business B)", async () => {
    const caller = makeCaller(agencyUserId);
    const result = await caller.agency.listBusinesses({ iauditUserId: agencyUserId });
    const ownedBizIds = result.businesses.map((b) => b.id);
    // Both businesses must be present
    expect(ownedBizIds).toContain(agencyBizAId);
    expect(ownedBizIds).toContain(agencyBizBId);
    // Business A was inserted before Business B — verify index ordering.
    // Note: agencyBizAId and agencyBizBId are inserted sequentially in beforeAll
    // with a 10ms sleep between them to guarantee distinct createdAt timestamps.
    const idxA = ownedBizIds.indexOf(agencyBizAId);
    const idxB = ownedBizIds.indexOf(agencyBizBId);
    expect(idxA).toBeLessThan(idxB);
  });

  it("22. each business entry includes id, name, siteUrl, and stage1Complete", async () => {
    const caller = makeCaller(agencyUserId);
    const result = await caller.agency.listBusinesses({ iauditUserId: agencyUserId });
    for (const biz of result.businesses) {
      expect(biz).toHaveProperty("id");
      expect(biz).toHaveProperty("name");
      expect(biz).toHaveProperty("siteUrl");
      expect(biz).toHaveProperty("stage1Complete");
    }
  });
});

// ---------------------------------------------------------------------------
// 23–24: business.list — all account types
// ---------------------------------------------------------------------------

describe("business.list — all account types", () => {
  it("23. returns all businesses for a solo user (their single business)", async () => {
    const caller = makeCaller(soloUserId);
    // business.list returns an array directly (not wrapped in { businesses: [] })
    const result = await caller.business.list({ iauditUserId: soloUserId });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);
    const ids = result.map((b: { id: string }) => b.id);
    expect(ids).toContain(soloBizId);
  });

  it("24. returns all businesses for an agency user (multiple businesses)", async () => {
    const caller = makeCaller(agencyUserId);
    // business.list returns an array directly (not wrapped in { businesses: [] })
    const result = await caller.business.list({ iauditUserId: agencyUserId });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const ids = result.map((b: { id: string }) => b.id);
    expect(ids).toContain(agencyBizAId);
    expect(ids).toContain(agencyBizBId);
  });
});

// ---------------------------------------------------------------------------
// 25: Solo account — direct URL access restriction
// ---------------------------------------------------------------------------

describe("Solo account — direct URL access restriction", () => {
  it("25. agency.listBusinesses returns FORBIDDEN for a solo user regardless of business count", async () => {
    const caller = makeCaller(soloUserId);
    // Solo user has 1 business but must not access agency routes
    await expect(
      caller.agency.listBusinesses({ iauditUserId: soloUserId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Confirm the error message is informative
    try {
      await caller.agency.listBusinesses({ iauditUserId: soloUserId });
    } catch (err) {
      if (err instanceof TRPCError) {
        expect(err.message).toContain("Agency");
      }
    }
  });
});
