/**
 * import.db.ts — DB helpers for import_jobs table.
 * Used by the background CMS import job system.
 */

import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { importJobs } from "../drizzle/schema";
import { nanoid } from "nanoid";

export type ImportJobStatus = "running" | "complete" | "failed";

export interface ImportJobRow {
  id: string;
  businessId: string;
  connectionId: string;
  status: ImportJobStatus;
  total: number;
  imported: number;
  keywordsAutoDetected: number;
  errors: string[] | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** Create a new import job row and return its ID. */
export async function createImportJob(
  businessId: string,
  connectionId: string
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = nanoid(21);
  await db.insert(importJobs).values({
    id,
    businessId,
    connectionId,
    status: "running",
    total: 0,
    imported: 0,
    keywordsAutoDetected: 0,
    errors: null,
  });
  return id;
}

/** Get a single import job by ID. */
export async function getImportJob(jobId: string): Promise<ImportJobRow | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, jobId))
    .limit(1);
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    id: row.id,
    businessId: row.businessId,
    connectionId: row.connectionId,
    status: row.status as ImportJobStatus,
    total: row.total,
    imported: row.imported,
    keywordsAutoDetected: row.keywordsAutoDetected,
    errors: (row.errors as string[] | null) ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
  };
}

/** Update progress counters on a running job. */
export async function updateImportJobProgress(
  jobId: string,
  delta: { importedDelta?: number; keywordsDelta?: number; error?: string }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const rows = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, jobId))
    .limit(1);
  if (!rows[0]) return;
  const current = rows[0];
  const errors = (current.errors as string[] | null) ?? [];
  if (delta.error) errors.push(delta.error);
  await db
    .update(importJobs)
    .set({
      imported: current.imported + (delta.importedDelta ?? 0),
      keywordsAutoDetected:
        current.keywordsAutoDetected + (delta.keywordsDelta ?? 0),
      errors: errors.length > 0 ? errors : null,
    })
    .where(eq(importJobs.id, jobId));
}

/** Set the total post count once we know how many posts were fetched. */
export async function setImportJobTotal(
  jobId: string,
  total: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(importJobs)
    .set({ total })
    .where(eq(importJobs.id, jobId));
}

/** Mark a job as complete or failed. */
export async function finishImportJob(
  jobId: string,
  status: "complete" | "failed"
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(importJobs)
    .set({ status, finishedAt: new Date() })
    .where(eq(importJobs.id, jobId));
}
