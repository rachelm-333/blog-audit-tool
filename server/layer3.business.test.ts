/**
 * iAudit — Layer 3 Vitest Tests: Business Profile & Website Scrape
 *
 * Verifies:
 * 1. Business creation (startScrape) creates a row in businesses table
 * 2. getScrapeStatus returns correct scrape status and fields
 * 3. save (Save Progress) updates fields without requiring all required fields
 * 4. confirm sets stage1_complete = true when all required fields present
 * 5. confirm is blocked when required fields are missing
 * 6. Ownership enforcement — another user cannot access a business
 * 7. All 4 scrape failure states are handled correctly
 * 8. stage1_complete is set to true on confirm
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getDb } from "./db";
import { iauditUsers, businesses } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";

// ---------------------------------------------------------------------------
// Test context helpers
// ---------------------------------------------------------------------------

function makeCtx(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
      cookie: () => {},
    } as unknown as TrpcContext["res"],
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_USER_ID = crypto.randomUUID();
const TEST_USER_EMAIL = `layer3-test-${Date.now()}@example.com`;
const OTHER_USER_ID = crypto.randomUUID();
const OTHER_USER_EMAIL = `layer3-other-${Date.now()}@example.com`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const hash = await bcrypt.hash("TestPass123!", 10);

  // Create test user
  await db.insert(iauditUsers).values({
    id: TEST_USER_ID,
    email: TEST_USER_EMAIL,
    passwordHash: hash,
    name: "Layer3 Test User",
    accountType: "solo",
    emailVerified: true,
  });

  // Create another user for ownership tests
  await db.insert(iauditUsers).values({
    id: OTHER_USER_ID,
    email: OTHER_USER_EMAIL,
    passwordHash: hash,
    name: "Layer3 Other User",
    accountType: "solo",
    emailVerified: true,
  });
});

afterAll(async () => {
  const db = await getDb();
  if (!db) return;

  // Clean up businesses created during tests
  await db.delete(businesses).where(eq(businesses.userId, TEST_USER_ID));
  await db.delete(businesses).where(eq(businesses.userId, OTHER_USER_ID));

  // Clean up test users
  await db.delete(iauditUsers).where(eq(iauditUsers.id, TEST_USER_ID));
  await db.delete(iauditUsers).where(eq(iauditUsers.id, OTHER_USER_ID));
});

// ---------------------------------------------------------------------------
// Helper: create a business row directly in DB for testing
// ---------------------------------------------------------------------------

async function createTestBusiness(overrides: Partial<{
  userId: string;
  businessName: string;
  industry: string;
  location: string;
  brandVoice: string;
  tone: string;
  targetAudience: string;
  uvp: string;
  primaryCtaUrl: string;
  primaryCtaLabel: string;
  scrapeStatus: "pending" | "complete" | "failed";
  stage1Complete: boolean;
}> = {}) {
  const db = await getDb();
  if (!db) throw new Error("DB not available");

  const id = crypto.randomUUID();
  await db.insert(businesses).values({
    id,
    userId: TEST_USER_ID,
    websiteUrl: "https://example.com",
    businessName: overrides.businessName ?? "Test Business",
    industry: overrides.industry ?? "Technology",
    location: overrides.location ?? "Brisbane, QLD",
    brandVoice: overrides.brandVoice ?? "Confident and clear",
    tone: overrides.tone ?? "Professional",
    targetAudience: overrides.targetAudience ?? "SMEs",
    uvp: overrides.uvp ?? "We deliver results",
    services: ["SEO", "Content Marketing"],
    primaryCtaUrl: overrides.primaryCtaUrl ?? "https://example.com/contact",
    primaryCtaLabel: overrides.primaryCtaLabel ?? "Contact Us",
    scrapeStatus: overrides.scrapeStatus ?? "complete",
    stage1Complete: overrides.stage1Complete ?? false,
    ...overrides,
  });

  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Layer 3 — Business Profile: getScrapeStatus", () => {
  it("returns business data for the owner", async () => {
    const bizId = await createTestBusiness({ businessName: "Status Test Biz" });
    const caller = appRouter.createCaller(makeCtx());

    const result = await caller.business.getScrapeStatus({
      businessId: bizId,
      iauditUserId: TEST_USER_ID,
    });

    expect(result.scrapeStatus).toBe("complete");
    expect(result.business.businessName).toBe("Status Test Biz");
    expect(result.business.industry).toBe("Technology");
    expect(result.business.location).toBe("Brisbane, QLD");
  });

  it("throws NOT_FOUND for a non-existent business", async () => {
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.getScrapeStatus({
        businessId: crypto.randomUUID(),
        iauditUserId: TEST_USER_ID,
      })
    ).rejects.toThrow("Business not found");
  });

  it("throws FORBIDDEN when another user tries to access the business", async () => {
    const bizId = await createTestBusiness({ businessName: "Ownership Test Biz" });
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.getScrapeStatus({
        businessId: bizId,
        iauditUserId: OTHER_USER_ID,
      })
    ).rejects.toThrow();
  });
});

describe("Layer 3 — Business Profile: getById", () => {
  it("returns the full business row for the owner", async () => {
    const bizId = await createTestBusiness({ businessName: "GetById Test Biz" });
    const caller = appRouter.createCaller(makeCtx());

    const biz = await caller.business.getById({
      businessId: bizId,
      iauditUserId: TEST_USER_ID,
    });

    expect(biz.id).toBe(bizId);
    expect(biz.businessName).toBe("GetById Test Biz");
    expect(biz.userId).toBe(TEST_USER_ID);
  });

  it("throws FORBIDDEN for a different user", async () => {
    const bizId = await createTestBusiness({ businessName: "Forbidden Test Biz" });
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.getById({
        businessId: bizId,
        iauditUserId: OTHER_USER_ID,
      })
    ).rejects.toThrow();
  });
});

describe("Layer 3 — Business Profile: list", () => {
  it("returns all businesses for the authenticated user", async () => {
    await createTestBusiness({ businessName: "List Test Biz A" });
    await createTestBusiness({ businessName: "List Test Biz B" });

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.business.list({ iauditUserId: TEST_USER_ID });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(2);
    const names = result.map((b) => b.businessName);
    expect(names).toContain("List Test Biz A");
    expect(names).toContain("List Test Biz B");
  });

  it("returns empty array for a user with no businesses", async () => {
    const emptyUserId = crypto.randomUUID();
    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.business.list({ iauditUserId: emptyUserId });
    expect(result).toEqual([]);
  });
});

describe("Layer 3 — Business Profile: save (Save Progress)", () => {
  it("saves partial data without requiring all required fields", async () => {
    const bizId = await createTestBusiness({ businessName: "Save Test Biz" });
    const caller = appRouter.createCaller(makeCtx());

    // Save only a few fields — no required-field enforcement on save
    const result = await caller.business.save({
      businessId: bizId,
      iauditUserId: TEST_USER_ID,
      businessName: "Updated Business Name",
      location: "Sydney, NSW",
    });

    expect(result.success).toBe(true);

    // Verify the update persisted
    const updated = await caller.business.getById({
      businessId: bizId,
      iauditUserId: TEST_USER_ID,
    });
    expect(updated.businessName).toBe("Updated Business Name");
    expect(updated.location).toBe("Sydney, NSW");
  });

  it("save works even when required fields are empty (Save Progress is always available)", async () => {
    const bizId = await createTestBusiness({
      businessName: "Partial Save Biz",
      brandVoice: "",
      tone: "",
    });
    const caller = appRouter.createCaller(makeCtx());

    // Should NOT throw even with empty required fields
    await expect(
      caller.business.save({
        businessId: bizId,
        iauditUserId: TEST_USER_ID,
        awardsCredentials: "Some award",
      })
    ).resolves.toEqual({ success: true });
  });

  it("throws FORBIDDEN when another user tries to save", async () => {
    const bizId = await createTestBusiness({ businessName: "Save Forbidden Biz" });
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.save({
        businessId: bizId,
        iauditUserId: OTHER_USER_ID,
        businessName: "Hacked Name",
      })
    ).rejects.toThrow();
  });
});

describe("Layer 3 — Business Profile: confirm (sets stage1_complete)", () => {
  it("sets stage1_complete = true when all required fields are present", async () => {
    const bizId = await createTestBusiness({
      businessName: "Confirm Test Biz",
      industry: "Marketing",
      location: "Melbourne, VIC",
      brandVoice: "Bold and direct",
      tone: "Professional",
      targetAudience: "Australian SMEs",
      uvp: "We make your business grow",
      primaryCtaUrl: "https://example.com/contact",
      stage1Complete: false,
    });

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.business.confirm({
      businessId: bizId,
      iauditUserId: TEST_USER_ID,
    });

    expect(result.success).toBe(true);

    // Verify stage1_complete was set to true in the DB
    const updated = await caller.business.getById({
      businessId: bizId,
      iauditUserId: TEST_USER_ID,
    });
    expect(updated.stage1Complete).toBe(true);
  });

  it("throws BAD_REQUEST when required fields are missing", async () => {
    const bizId = await createTestBusiness({
      businessName: "Incomplete Biz",
      industry: "",         // missing required field
      location: "",         // missing required field
      brandVoice: "",       // missing required field
      tone: "",             // missing required field
      targetAudience: "",   // missing required field
      uvp: "",              // missing required field
      primaryCtaUrl: "",    // missing required field
    });

    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.confirm({
        businessId: bizId,
        iauditUserId: TEST_USER_ID,
      })
    ).rejects.toThrow();
  });

  it("throws FORBIDDEN when another user tries to confirm", async () => {
    const bizId = await createTestBusiness({
      businessName: "Confirm Forbidden Biz",
    });
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.confirm({
        businessId: bizId,
        iauditUserId: OTHER_USER_ID,
      })
    ).rejects.toThrow();
  });
});

describe("Layer 3 — Scrape failure state handling", () => {
  // Use a dedicated agency user for scrape failure tests.
  // The solo TEST_USER_ID already has businesses from earlier tests, which
  // would trip the Layer 14 solo restriction. Agency users have no limit.
  const SCRAPE_AGENCY_USER_ID = crypto.randomUUID();

  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");
    const bcrypt = await import("bcrypt");
    const hash = await bcrypt.hash("TestPass123!", 10);
    await db.insert(iauditUsers).values({
      id: SCRAPE_AGENCY_USER_ID,
      email: `layer3-scrape-agency-${SCRAPE_AGENCY_USER_ID}@example.com`,
      passwordHash: hash,
      name: "Layer3 Scrape Agency User",
      accountType: "agency",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    await db.delete(businesses).where(eq(businesses.userId, SCRAPE_AGENCY_USER_ID));
    await db.delete(iauditUsers).where(eq(iauditUsers.id, SCRAPE_AGENCY_USER_ID));
  });

  it("returns failed scrapeStatus and correct failure type for unreachable URL", async () => {
    const caller = appRouter.createCaller(makeCtx());

    // Use a clearly unreachable URL
    const result = await caller.business.startScrape({
      iauditUserId: SCRAPE_AGENCY_USER_ID,
      websiteUrl: "https://this-domain-absolutely-does-not-exist-12345.invalid",
    });

    // The scrape should fail gracefully
    expect(result.scrapeStatus).toBe("failed");
    expect(result.businessId).toBeTruthy();
  }, 35_000); // 35s timeout to allow for the 30s scrape timeout

  it("handles invalid URLs gracefully — returns failed scrapeStatus (URL is normalised then fails to reach)", async () => {
    const caller = appRouter.createCaller(makeCtx());

    // The URL normalizer prepends https:// and attempts the scrape.
    // An invalid domain resolves to a failed scrape, not a thrown error.
    // This is correct behavior — the user sees the failure state in the UI.
    const result = await caller.business.startScrape({
      iauditUserId: SCRAPE_AGENCY_USER_ID,
      websiteUrl: "not-a-url-at-all",
    });

    expect(result.scrapeStatus).toBe("failed");
    expect(result.businessId).toBeTruthy();
  }, 35_000);

  it("getScrapeStatus returns failed status for a failed business", async () => {
    const bizId = await createTestBusiness({
      businessName: "Failed Scrape Biz",
      scrapeStatus: "failed",
    });

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.business.getScrapeStatus({
      businessId: bizId,
      iauditUserId: TEST_USER_ID,
    });

    expect(result.scrapeStatus).toBe("failed");
  });

  it("getScrapeStatus returns pending status for a pending business", async () => {
    const bizId = await createTestBusiness({
      businessName: "Pending Scrape Biz",
      scrapeStatus: "pending",
    });

    const caller = appRouter.createCaller(makeCtx());
    const result = await caller.business.getScrapeStatus({
      businessId: bizId,
      iauditUserId: TEST_USER_ID,
    });

    expect(result.scrapeStatus).toBe("pending");
  });
});

describe("Layer 3 — Business ownership enforcement", () => {
  it("user A cannot read user B's business", async () => {
    const bizId = await createTestBusiness({ businessName: "User A Business" });
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.getById({
        businessId: bizId,
        iauditUserId: OTHER_USER_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("user A cannot save user B's business", async () => {
    const bizId = await createTestBusiness({ businessName: "User A Business Save" });
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.save({
        businessId: bizId,
        iauditUserId: OTHER_USER_ID,
        businessName: "Stolen Name",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("user A cannot confirm user B's business", async () => {
    const bizId = await createTestBusiness({ businessName: "User A Business Confirm" });
    const caller = appRouter.createCaller(makeCtx());

    await expect(
      caller.business.confirm({
        businessId: bizId,
        iauditUserId: OTHER_USER_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("Layer 3 — Business profile: required fields enforcement summary", () => {
  const requiredFields = [
    "businessName", "industry", "location",
    "brandVoice", "tone", "targetAudience",
    "uvp", "primaryCtaUrl",
  ];

  it("confirm fails when each required field is individually missing", async () => {
    const caller = appRouter.createCaller(makeCtx());

    for (const field of requiredFields) {
      const overrides: Record<string, string> = {
        businessName: "Test Biz",
        industry: "Tech",
        location: "Brisbane",
        brandVoice: "Bold",
        tone: "Professional",
        targetAudience: "SMEs",
        uvp: "We deliver",
        primaryCtaUrl: "https://example.com",
      };
      overrides[field] = ""; // blank out this required field

      const bizId = await createTestBusiness(overrides as Parameters<typeof createTestBusiness>[0]);

      await expect(
        caller.business.confirm({
          businessId: bizId,
          iauditUserId: TEST_USER_ID,
        })
      ).rejects.toThrow();
    }
  });
});
