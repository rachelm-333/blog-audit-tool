/**
 * public-audit.db.ts — DB helpers for Layer 10 free public audit tool.
 *
 * Manages the free_rewrites table:
 *  - checkEmailUsed: returns true if the email already has a free rewrite record
 *  - recordFreeRewrite: inserts a new record (throws if email already used — DB unique constraint)
 *  - getFreeRewriteByEmail: returns the existing record for an email (or null)
 */

import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { freeRewrites } from "../drizzle/schema";
import type { FreeRewrite } from "../drizzle/schema";

export async function checkEmailUsed(email: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ id: freeRewrites.id })
    .from(freeRewrites)
    .where(eq(freeRewrites.email, email.toLowerCase().trim()))
    .limit(1);

  return rows.length > 0;
}

export interface RecordFreeRewriteInput {
  email: string;
  postUrl: string;
  auditScoreBefore: number;
  rewriteScoreAfter: number;
  bodyRewritten: string;
  metaTitleRewritten: string;
  metaDescriptionRewritten: string;
}

export async function recordFreeRewrite(
  input: RecordFreeRewriteInput
): Promise<FreeRewrite> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const id = nanoid(21);
  const normalizedEmail = input.email.toLowerCase().trim();

  await db.insert(freeRewrites).values({
    id,
    email: normalizedEmail,
    postUrl: input.postUrl,
    auditScoreBefore: input.auditScoreBefore,
    rewriteScoreAfter: input.rewriteScoreAfter,
    bodyRewritten: input.bodyRewritten,
    metaTitleRewritten: input.metaTitleRewritten,
    metaDescriptionRewritten: input.metaDescriptionRewritten,
  });

  const rows = await db
    .select()
    .from(freeRewrites)
    .where(eq(freeRewrites.id, id))
    .limit(1);

  return rows[0]!;
}

export async function getFreeRewriteByEmail(
  email: string
): Promise<FreeRewrite | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select()
    .from(freeRewrites)
    .where(eq(freeRewrites.email, email.toLowerCase().trim()))
    .limit(1);

  return rows[0] ?? null;
}
