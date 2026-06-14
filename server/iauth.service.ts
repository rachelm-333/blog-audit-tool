/**
 * iAudit Authentication Service — Layer 2
 *
 * Handles: bcrypt hashing, JWT signing/verification, secure token generation,
 * refresh token rotation, and Resend email delivery for verification + password reset.
 *
 * All tokens are invalidated on password change or account suspension (Section 4.3).
 * Admin account_type cannot be set via public registration (Section 3).
 */

import bcrypt from "bcrypt";
import { createHmac, randomBytes } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { Resend } from "resend";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// OWASP minimum is 10; 12 was ~400ms per hash on 1 vCPU which made login take 3-4s.
// 10 rounds = ~100ms per hash — still secure, 4× faster.
const BCRYPT_ROUNDS = 10;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_DAYS = 30; // 30 days
const VERIFICATION_TOKEN_TTL_HOURS = 24; // 24 hours for email verification
const RESET_TOKEN_TTL_HOURS = 1; // 1 hour for password reset (scope requirement)

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is not set");
  return new TextEncoder().encode(secret);
}

function getResendClient(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY environment variable is not set");
  return new Resend(key);
}

function getFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL ?? "noreply@iaudit.com.au";
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Validates password strength per Section 4.1:
 * min 8 chars, at least 1 number, at least 1 special character.
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  reason?: string;
} {
  if (password.length < 8) {
    return { valid: false, reason: "Password must be at least 8 characters" };
  }
  if (!/\d/.test(password)) {
    return { valid: false, reason: "Password must contain at least one number" };
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return {
      valid: false,
      reason: "Password must contain at least one special character",
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// JWT — Access tokens (15-minute expiry)
// ---------------------------------------------------------------------------

export interface AccessTokenPayload {
  sub: string; // iaudit_users.id
  email: string;
  accountType: "solo" | "agency" | "admin";
  emailVerified: boolean;
}

export async function signAccessToken(
  payload: AccessTokenPayload
): Promise<string> {
  return new SignJWT({
    email: payload.email,
    accountType: payload.accountType,
    emailVerified: payload.emailVerified,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getJwtSecret());
}

export async function verifyAccessToken(
  token: string
): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return {
      sub: payload.sub as string,
      email: payload["email"] as string,
      accountType: payload["accountType"] as AccessTokenPayload["accountType"],
      emailVerified: payload["emailVerified"] as boolean,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens — raw token + SHA-256 hash stored in DB
// ---------------------------------------------------------------------------

export function generateRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(40).toString("hex"); // 80-char hex string
  const hash = createHmac("sha256", process.env.JWT_SECRET ?? "secret")
    .update(raw)
    .digest("hex");
  return { raw, hash };
}

export function hashRefreshToken(raw: string): string {
  return createHmac("sha256", process.env.JWT_SECRET ?? "secret")
    .update(raw)
    .digest("hex");
}

export function refreshTokenExpiresAt(): Date {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_TOKEN_TTL_DAYS);
  return d;
}

// ---------------------------------------------------------------------------
// One-time tokens — email verification + password reset
// ---------------------------------------------------------------------------

export function generateSecureToken(): string {
  return randomBytes(32).toString("hex"); // 64-char hex string
}

export function verificationTokenExpiresAt(): Date {
  const d = new Date();
  d.setHours(d.getHours() + VERIFICATION_TOKEN_TTL_HOURS);
  return d;
}

export function resetTokenExpiresAt(): Date {
  const d = new Date();
  d.setHours(d.getHours() + RESET_TOKEN_TTL_HOURS);
  return d;
}

export function generateUUID(): string {
  return nanoid(21); // URL-safe 21-char ID used as UUID substitute
}

// ---------------------------------------------------------------------------
// Resend email helpers
// ---------------------------------------------------------------------------

export async function sendVerificationEmail(
  to: string,
  name: string,
  token: string,
  origin: string
): Promise<void> {
  const resend = getResendClient();
  const verifyUrl = `${origin}/verify-email?token=${token}`;

  await resend.emails.send({
    from: getFromEmail(),
    to,
    subject: "Verify your iAudit email address",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to iAudit, ${name}!</h2>
        <p>Please verify your email address to activate your account.</p>
        <p>
          <a href="${verifyUrl}" style="
            display: inline-block;
            background: #1A7A4A;
            color: white;
            padding: 12px 24px;
            border-radius: 6px;
            text-decoration: none;
            font-weight: bold;
          ">Verify Email Address</a>
        </p>
        <p style="color: #666; font-size: 14px;">
          This link expires in 24 hours. If you did not create an iAudit account, you can safely ignore this email.
        </p>
        <p style="color: #666; font-size: 12px;">
          Or copy this link: ${verifyUrl}
        </p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  token: string,
  origin: string
): Promise<void> {
  const resend = getResendClient();
  const resetUrl = `${origin}/reset-password?token=${token}`;

  await resend.emails.send({
    from: getFromEmail(),
    to,
    subject: "Reset your iAudit password",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Password Reset Request</h2>
        <p>Hi ${name},</p>
        <p>We received a request to reset your iAudit password. Click the button below to set a new password.</p>
        <p>
          <a href="${resetUrl}" style="
            display: inline-block;
            background: #2E6DA4;
            color: white;
            padding: 12px 24px;
            border-radius: 6px;
            text-decoration: none;
            font-weight: bold;
          ">Reset Password</a>
        </p>
        <p style="color: #666; font-size: 14px;">
          This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email — your password will not be changed.
        </p>
        <p style="color: #666; font-size: 12px;">
          Or copy this link: ${resetUrl}
        </p>
      </div>
    `,
  });
}
