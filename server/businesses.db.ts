/**
 * iAudit — Businesses DB Helpers (Layer 3)
 * All database operations for the businesses table.
 */

import { eq, asc } from "drizzle-orm";
import { getDb } from "./db";
import { businesses, type Business, type InsertBusiness } from "../drizzle/schema";

// ---------------------------------------------------------------------------
// Create a new business row (scrape_status = pending, stage1_complete = false)
// ---------------------------------------------------------------------------
export async function createBusiness(data: InsertBusiness): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(businesses).values(data);
}

// ---------------------------------------------------------------------------
// Get all businesses for a user
// ---------------------------------------------------------------------------
export async function getBusinessesByUserId(userId: string): Promise<Business[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.select().from(businesses).where(eq(businesses.userId, userId)).orderBy(asc(businesses.createdAt));
}

// ---------------------------------------------------------------------------
// Get a single business by ID
// ---------------------------------------------------------------------------
export async function getBusinessById(id: string): Promise<Business | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Update any fields on a business (partial update)
// ---------------------------------------------------------------------------
export async function updateBusiness(
  id: string,
  data: Partial<InsertBusiness>
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.update(businesses).set(data).where(eq(businesses.id, id));
}

// ---------------------------------------------------------------------------
// Set stage1_complete = true and scrape_status = complete
// ---------------------------------------------------------------------------
export async function confirmBusinessStage1(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(businesses)
    .set({ stage1Complete: true, scrapeStatus: "complete" })
    .where(eq(businesses.id, id));
}

// ---------------------------------------------------------------------------
// Delete a business (used in tests only)
// ---------------------------------------------------------------------------
export async function deleteBusiness(id: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.delete(businesses).where(eq(businesses.id, id));
}
