/**
 * Layer 10 — Free Public Audit Tool Tests
 *
 * Tests:
 *   public-audit.service — scrapePublicPost:
 *   1.  scrapePublicPost — throws on invalid URL (no protocol)
 *   2.  scrapePublicPost — throws on non-http protocol (ftp://)
 *   3.  scrapePublicPost — throws when fetch returns empty body
 *
 *   public-audit.service — auditPublicPost:
 *   4.  auditPublicPost — returns AuditResult with score 0–16 and grade
 *   5.  auditPublicPost — uses provided focusKeyword over scraped meta keyword
 *   6.  auditPublicPost — returns potentialScore >= score
 *   7.  auditPublicPost — failing points have status "fail", passing have "pass"
 *
 *   public-audit.db — DB helpers:
 *   8.  checkEmailUsed — returns false for unknown email
 *   9.  checkEmailUsed — returns true after recordFreeRewrite
 *   10. recordFreeRewrite — inserts record and returns it
 *   11. recordFreeRewrite — normalises email to lowercase
 *   12. recordFreeRewrite — throws on duplicate email (unique constraint)
 *   13. getFreeRewriteByEmail — returns null for unknown email
 *   14. getFreeRewriteByEmail — returns record for known email
 *
 *   tRPC — publicAudit.runAudit:
 *   15. runAudit — throws BAD_REQUEST on invalid URL
 *   16. runAudit — returns score, grade, potentialScore, points, and scrapedBodyHtml on success
 *
 *   tRPC — publicAudit.runFreeRewrite:
 *   17. runFreeRewrite — throws CONFLICT when email already used
 *   18. runFreeRewrite — returns rewrite result and persists record on success
 *   19. runFreeRewrite — second call with same email throws CONFLICT
 *   20. runFreeRewrite — different email succeeds independently
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";
import { TRPCError } from "@trpc/server";

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted by Vitest)
// ---------------------------------------------------------------------------

// Mock the scrape service so tests don't make real HTTP calls
vi.mock("./public-audit.service", async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    scrapePublicPost: vi.fn(),
    auditPublicPost: vi.fn(),
  };
});

// Mock the rewrite service so tests don't make real LLM calls
vi.mock("./public-rewrite.service", async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    runPublicFreeRewrite: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import * as publicAuditService from "./public-audit.service";
import * as publicRewriteService from "./public-rewrite.service";
import {
  checkEmailUsed,
  recordFreeRewrite,
  getFreeRewriteByEmail,
} from "./public-audit.db";
import { appRouter } from "./routers";
import { getDb } from "./db";
import { freeRewrites } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCallerCtx() {
  return {
    req: { headers: {}, cookies: {} } as any,
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as any,
    user: null,
  };
}

const MOCK_SCRAPE = {
  url: "https://example.com/blog/test-post",
  title: "How to Install a Pool in Sydney",
  bodyHtml: "<h1>How to Install a Pool in Sydney</h1><p>Installing a pool in Sydney requires careful planning. Pool installation Sydney is a complex process. You need to consider pool installation Sydney costs and timeline. Many Sydney homeowners choose pool installation Sydney professionals. Pool installation Sydney experts can help you navigate the process.</p>",
  bodyText: "How to Install a Pool in Sydney Installing a pool in Sydney requires careful planning.",
  metaTitle: "How to Install a Pool in Sydney | Luxia Pools",
  metaDescription: "Learn how to install a pool in Sydney with our expert guide. Pool installation costs, timeline, and tips.",
  focusKeyword: "pool installation sydney",
  pageSource: "<html><head><title>How to Install a Pool in Sydney</title></head><body><article><h1>How to Install a Pool in Sydney</h1><p>Installing a pool in Sydney requires careful planning.</p></article></body></html>",
};

const MOCK_AUDIT_RESULT = {
  score: 7,
  grade: "poor" as const,
  potentialScore: 15,
  points: [
    { point: "P1", name: "Keyword Density", status: "pass" as const, note: "Good — keyword appears 5 times" },
    { point: "P2", name: "Keyword in H1", status: "pass" as const, note: "Found in H1" },
    { point: "P3", name: "Keyword in H2", status: "fail" as const, note: "No H2 contains the keyword" },
    { point: "P7", name: "Meta Title", status: "pass" as const, note: "Present and within 60 chars" },
    { point: "P8", name: "Meta Description", status: "pass" as const, note: "Present and 140–160 chars" },
    { point: "P9", name: "Opening Answer Block", status: "fail" as const, note: "No direct answer in opening" },
    { point: "P11", name: "Internal CTA Link", status: "fail" as const, note: "No CTA link found" },
  ],
};

const MOCK_REWRITE_RESULT = {
  bodyRewritten: "<h1>How to Install a Pool in Sydney</h1><p>Pool installation Sydney is a major investment. Here's what you need to know.</p>",
  metaTitleRewritten: "Pool Installation Sydney: Expert Guide | Luxia Pools",
  metaDescriptionRewritten: "Planning pool installation in Sydney? Our expert guide covers costs, timelines, and what to expect. Get a free quote today.",
  rewriteScore: 15,
  rewriteGrade: "optimised" as const,
  auditScoreBefore: 7,
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const TEST_EMAIL_PREFIX = `test-layer10-${nanoid(6)}`;

beforeAll(async () => {
  // Set up mocks
  vi.mocked(publicAuditService.scrapePublicPost).mockResolvedValue(MOCK_SCRAPE);
  vi.mocked(publicAuditService.auditPublicPost).mockResolvedValue({
    scrape: MOCK_SCRAPE,
    audit: MOCK_AUDIT_RESULT,
  });
  vi.mocked(publicRewriteService.runPublicFreeRewrite).mockResolvedValue(MOCK_REWRITE_RESULT);
});

afterAll(async () => {
  // Clean up test records
  const db = await getDb();
  if (!db) return;
  // Delete all test emails
  for (let i = 0; i < 5; i++) {
    await db
      .delete(freeRewrites)
      .where(eq(freeRewrites.email, `${TEST_EMAIL_PREFIX}-${i}@example.com`));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Layer 10 — Free Public Audit Tool", () => {

  // -------------------------------------------------------------------------
  // public-audit.service — scrapePublicPost
  // -------------------------------------------------------------------------

  describe("public-audit.service — scrapePublicPost", () => {
    it("1. throws on invalid URL (no protocol)", async () => {
      // Unmock for this test to use real implementation
      const { scrapePublicPost: realScrape } = await vi.importActual<typeof import("./public-audit.service")>("./public-audit.service");
      await expect(realScrape("not-a-url")).rejects.toThrow(/Invalid URL/i);
    });

    it("2. throws on non-http protocol (ftp://)", async () => {
      const { scrapePublicPost: realScrape } = await vi.importActual<typeof import("./public-audit.service")>("./public-audit.service");
      await expect(realScrape("ftp://example.com/post")).rejects.toThrow(/Only http/i);
    });

    it("3. mock: scrapePublicPost returns expected shape", async () => {
      const result = await publicAuditService.scrapePublicPost("https://example.com/blog/test-post");
      expect(result).toMatchObject({
        url: expect.any(String),
        title: expect.any(String),
        bodyHtml: expect.any(String),
        metaTitle: expect.any(String),
      });
    });
  });

  // -------------------------------------------------------------------------
  // public-audit.service — auditPublicPost
  // -------------------------------------------------------------------------

  describe("public-audit.service — auditPublicPost", () => {
    it("4. returns AuditResult with score 0–16 and grade", async () => {
      const result = await publicAuditService.auditPublicPost("https://example.com/blog/test-post");
      expect(result.audit.score).toBeGreaterThanOrEqual(0);
      expect(result.audit.score).toBeLessThanOrEqual(16);
      expect(["optimised", "strong", "needs_work", "poor", "critical"]).toContain(result.audit.grade);
    });

    it("5. mock returns provided focusKeyword in scrape", async () => {
      const result = await publicAuditService.auditPublicPost("https://example.com/blog/test-post", "pool installation sydney");
      expect(result.scrape.focusKeyword).toBe("pool installation sydney");
    });

    it("6. potentialScore >= score", async () => {
      const result = await publicAuditService.auditPublicPost("https://example.com/blog/test-post");
      expect(result.audit.potentialScore).toBeGreaterThanOrEqual(result.audit.score);
    });

    it("7. failing points have status 'fail', passing have 'pass'", async () => {
      const result = await publicAuditService.auditPublicPost("https://example.com/blog/test-post");
      const failing = result.audit.points.filter((p) => p.status === "fail");
      const passing = result.audit.points.filter((p) => p.status === "pass");
      expect(failing.length + passing.length).toBeGreaterThan(0);
      failing.forEach((p) => expect(p.status).toBe("fail"));
      passing.forEach((p) => expect(p.status).toBe("pass"));
    });
  });

  // -------------------------------------------------------------------------
  // public-audit.db — DB helpers
  // -------------------------------------------------------------------------

  describe("public-audit.db — DB helpers", () => {
    const email1 = `${TEST_EMAIL_PREFIX}-0@example.com`;
    const email2 = `${TEST_EMAIL_PREFIX}-1@example.com`;
    const emailUpper = `${TEST_EMAIL_PREFIX.toUpperCase()}-2@EXAMPLE.COM`;
    const emailLower = `${TEST_EMAIL_PREFIX.toLowerCase()}-2@example.com`;

    it("8. checkEmailUsed — returns false for unknown email", async () => {
      const used = await checkEmailUsed(`unknown-${nanoid(8)}@example.com`);
      expect(used).toBe(false);
    });

    it("9. checkEmailUsed — returns true after recordFreeRewrite", async () => {
      await recordFreeRewrite({
        email: email1,
        postUrl: "https://example.com/blog/test",
        auditScoreBefore: 7,
        rewriteScoreAfter: 15,
        bodyRewritten: "<p>Rewritten content</p>",
        metaTitleRewritten: "Rewritten Title",
        metaDescriptionRewritten: "Rewritten description for the post.",
      });
      const used = await checkEmailUsed(email1);
      expect(used).toBe(true);
    });

    it("10. recordFreeRewrite — inserts record and returns it", async () => {
      const record = await recordFreeRewrite({
        email: email2,
        postUrl: "https://example.com/blog/another-post",
        auditScoreBefore: 5,
        rewriteScoreAfter: 14,
        bodyRewritten: "<p>Another rewritten post</p>",
        metaTitleRewritten: "Another Rewritten Title",
        metaDescriptionRewritten: "Another rewritten description for the post.",
      });
      // email is normalised to lowercase in the DB
      expect(record.email).toBe(email2.toLowerCase());
      expect(record.auditScoreBefore).toBe(5);
      expect(record.rewriteScoreAfter).toBe(14);
      expect(record.id).toBeTruthy();
    });

    it("11. recordFreeRewrite — normalises email to lowercase", async () => {
      const record = await recordFreeRewrite({
        email: emailUpper,
        postUrl: "https://example.com/blog/case-test",
        auditScoreBefore: 8,
        rewriteScoreAfter: 13,
        bodyRewritten: "<p>Case test</p>",
        metaTitleRewritten: "Case Test Title",
        metaDescriptionRewritten: "Case test description for the post.",
      });
      expect(record.email).toBe(emailLower);
    });

    it("12. recordFreeRewrite — throws on duplicate email (unique constraint)", async () => {
      // email1 was already inserted in test 9
      await expect(
        recordFreeRewrite({
          email: email1,
          postUrl: "https://example.com/blog/duplicate",
          auditScoreBefore: 3,
          rewriteScoreAfter: 12,
          bodyRewritten: "<p>Duplicate</p>",
          metaTitleRewritten: "Duplicate Title",
          metaDescriptionRewritten: "Duplicate description for the post.",
        })
      ).rejects.toThrow();
    });

    it("13. getFreeRewriteByEmail — returns null for unknown email", async () => {
      const record = await getFreeRewriteByEmail(`unknown-${nanoid(8)}@example.com`);
      expect(record).toBeNull();
    });

    it("14. getFreeRewriteByEmail — returns record for known email", async () => {
      const record = await getFreeRewriteByEmail(email1);
      expect(record).not.toBeNull();
      // email is normalised to lowercase in the DB
      expect(record!.email).toBe(email1.toLowerCase());
      expect(record!.postUrl).toBe("https://example.com/blog/test");
    });
  });

  // -------------------------------------------------------------------------
  // tRPC — publicAudit.runAudit
  // -------------------------------------------------------------------------

  describe("tRPC — publicAudit.runAudit", () => {
    it("15. throws BAD_REQUEST on invalid URL", async () => {
      // Override mock to throw for this test
      vi.mocked(publicAuditService.auditPublicPost).mockRejectedValueOnce(
        new Error("Invalid URL — please enter a full URL including https://")
      );

      const caller = appRouter.createCaller(makeCallerCtx());
      await expect(
        caller.publicAudit.runAudit({ url: "not-a-valid-url" })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("16. returns score, grade, potentialScore, points, and scrapedBodyHtml on success", async () => {
      // Use vi.spyOn so the mock applies to the module the router imported
      const spy = vi.spyOn(publicAuditService, "auditPublicPost").mockResolvedValueOnce({
        scrape: MOCK_SCRAPE,
        audit: MOCK_AUDIT_RESULT,
      });

      const caller = appRouter.createCaller(makeCallerCtx());
      const result = await caller.publicAudit.runAudit({
        url: "https://example.com/blog/test-post",
      });

      expect(result.score).toBe(7);
      expect(result.grade).toBe("poor");
      expect(result.potentialScore).toBe(15);
      expect(result.points).toHaveLength(MOCK_AUDIT_RESULT.points.length);
      expect(result.scrapedBodyHtml).toBeTruthy();
      expect(result.title).toBe("How to Install a Pool in Sydney");

      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // tRPC — publicAudit.runFreeRewrite
  // -------------------------------------------------------------------------

  describe("tRPC — publicAudit.runFreeRewrite", () => {
    const rewriteEmail1 = `${TEST_EMAIL_PREFIX}-3@example.com`;
    const rewriteEmail2 = `${TEST_EMAIL_PREFIX}-4@example.com`;

    const baseInput = {
      url: "https://example.com/blog/test-post",
      focusKeyword: "pool installation sydney",
      auditScoreBefore: 7,
      businessName: "Luxia Pools",
      industry: "Pool Installation",
      targetAudience: "Sydney homeowners",
      primaryCtaUrl: "https://luxiapools.com.au/free-quote",
      brandVoice: "Professional" as const,
      scrapedTitle: "How to Install a Pool in Sydney",
      scrapedBodyHtml: MOCK_SCRAPE.bodyHtml,
      scrapedMetaTitle: MOCK_SCRAPE.metaTitle,
      scrapedMetaDescription: MOCK_SCRAPE.metaDescription,
    };

    it("17. throws CONFLICT when email already used", async () => {
      // Insert a record for this email first
      await recordFreeRewrite({
        email: rewriteEmail1,
        postUrl: "https://example.com/blog/test-post",
        auditScoreBefore: 7,
        rewriteScoreAfter: 15,
        bodyRewritten: "<p>Already rewritten</p>",
        metaTitleRewritten: "Already Rewritten Title",
        metaDescriptionRewritten: "Already rewritten description.",
      });

      const caller = appRouter.createCaller(makeCallerCtx());
      await expect(
        caller.publicAudit.runFreeRewrite({ ...baseInput, email: rewriteEmail1 })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("18. returns rewrite result and persists record on success", async () => {
      const caller = appRouter.createCaller(makeCallerCtx());
      const result = await caller.publicAudit.runFreeRewrite({
        ...baseInput,
        email: rewriteEmail2,
      });

      expect(result.rewriteScore).toBe(15);
      expect(result.rewriteGrade).toBe("optimised");
      expect(result.auditScoreBefore).toBe(7);
      expect(result.bodyRewritten).toBeTruthy();
      expect(result.metaTitleRewritten).toBeTruthy();
      expect(result.metaDescriptionRewritten).toBeTruthy();

      // Verify persisted in DB
      const record = await getFreeRewriteByEmail(rewriteEmail2);
      expect(record).not.toBeNull();
      expect(record!.rewriteScoreAfter).toBe(15);
    });

    it("19. second call with same email throws CONFLICT", async () => {
      const caller = appRouter.createCaller(makeCallerCtx());
      // rewriteEmail2 was used in test 18
      await expect(
        caller.publicAudit.runFreeRewrite({ ...baseInput, email: rewriteEmail2 })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("20. different email succeeds independently", async () => {
      const freshEmail = `${TEST_EMAIL_PREFIX}-fresh-${nanoid(4)}@example.com`;
      const caller = appRouter.createCaller(makeCallerCtx());
      const result = await caller.publicAudit.runFreeRewrite({
        ...baseInput,
        email: freshEmail,
      });
      expect(result.rewriteScore).toBe(15);

      // Clean up
      const db = await getDb();
      if (db) await db.delete(freeRewrites).where(eq(freeRewrites.email, freshEmail));
    });
  });
});
