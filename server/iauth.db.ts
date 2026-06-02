/**
 * iAudit Auth DB Helpers — Layer 2
 * All database operations for the iAudit auth system.
 * Uses the shared getDb() connection from db.ts.
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "./db";
import {
  emailVerificationTokens,
  iauditUsers,
  passwordResetTokens,
  refreshTokens,
  type IauditUser,
  type InsertIauditUser,
} from "../drizzle/schema";

// ---------------------------------------------------------------------------
// iaudit_users helpers
// ---------------------------------------------------------------------------

export async function createIauditUser(
  data: InsertIauditUser
): Promise<IauditUser> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(iauditUsers).values(data);
  const rows = await db
    .select()
    .from(iauditUsers)
    .where(eq(iauditUsers.id, data.id!))
    .limit(1);
  if (!rows[0]) throw new Error("Failed to retrieve created user");
  return rows[0];
}

export async function getIauditUserById(
  id: string
): Promise<IauditUser | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select()
    .from(iauditUsers)
    .where(eq(iauditUsers.id, id))
    .limit(1);
  return rows[0];
}

export async function getIauditUserByEmail(
  email: string
): Promise<IauditUser | undefined> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select()
    .from(iauditUsers)
    .where(eq(iauditUsers.email, email.toLowerCase()))
    .limit(1);
  return rows[0];
}

export async function setEmailVerified(userId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(iauditUsers)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(iauditUsers.id, userId));
}

export async function updatePassword(
  userId: string,
  newPasswordHash: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(iauditUsers)
    .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
    .where(eq(iauditUsers.id, userId));
}

// ---------------------------------------------------------------------------
// email_verification_tokens helpers
// ---------------------------------------------------------------------------

export async function createEmailVerificationToken(data: {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Delete any existing tokens for this user first
  await db
    .delete(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, data.userId));
  await db.insert(emailVerificationTokens).values(data);
}

export async function getEmailVerificationToken(token: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  const rows = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.token, token),
        gt(emailVerificationTokens.expiresAt, now)
      )
    )
    .limit(1);
  return rows[0];
}

export async function deleteEmailVerificationToken(token: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .delete(emailVerificationTokens)
    .where(eq(emailVerificationTokens.token, token));
}

// ---------------------------------------------------------------------------
// password_reset_tokens helpers
// ---------------------------------------------------------------------------

export async function createPasswordResetToken(data: {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Invalidate any existing unused reset tokens for this user
  await db
    .update(passwordResetTokens)
    .set({ used: true })
    .where(
      and(
        eq(passwordResetTokens.userId, data.userId),
        eq(passwordResetTokens.used, false)
      )
    );
  await db.insert(passwordResetTokens).values(data);
}

export async function getPasswordResetToken(token: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  const rows = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.token, token),
        eq(passwordResetTokens.used, false),
        gt(passwordResetTokens.expiresAt, now)
      )
    )
    .limit(1);
  return rows[0];
}

export async function markPasswordResetTokenUsed(token: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(passwordResetTokens)
    .set({ used: true })
    .where(eq(passwordResetTokens.token, token));
}

// ---------------------------------------------------------------------------
// refresh_tokens helpers
// ---------------------------------------------------------------------------

export async function createRefreshToken(data: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(refreshTokens).values(data);
}

export async function getActiveRefreshToken(tokenHash: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, now)
      )
    )
    .limit(1);
  return rows[0];
}

/**
 * Rotate a refresh token: revoke the old one, create a new one.
 * Records the replacement chain for replay-attack detection.
 */
export async function rotateRefreshToken(
  oldTokenHash: string,
  newToken: { id: string; userId: string; tokenHash: string; expiresAt: Date }
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  // Revoke old token, record what replaced it
  await db
    .update(refreshTokens)
    .set({ revokedAt: now, replacedByTokenHash: newToken.tokenHash })
    .where(eq(refreshTokens.tokenHash, oldTokenHash));
  // Insert new token
  await db.insert(refreshTokens).values(newToken);
}

/**
 * Revoke all active refresh tokens for a user.
 * Called on logout, password change, or account suspension.
 */
export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const now = new Date();
  await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(
      and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))
    );
}

/**
 * Revoke a single refresh token by hash (logout from current device).
 */
export async function revokeRefreshToken(tokenHash: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.tokenHash, tokenHash));
}
