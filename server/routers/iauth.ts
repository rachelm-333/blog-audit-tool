/**
 * iAudit Auth Router — Layer 2
 *
 * Procedures:
 *  - iauth.register       — create account (solo/agency only via public form)
 *  - iauth.verifyEmail    — confirm email with token from Resend link
 *  - iauth.login          — email + password → access JWT + refresh token cookie
 *  - iauth.logout         — revoke current refresh token
 *  - iauth.refresh        — rotate refresh token, issue new access token
 *  - iauth.forgotPassword — send reset link via Resend (1-hour expiry)
 *  - iauth.resetPassword  — validate token, hash new password, revoke all tokens
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import {
  createEmailVerificationToken,
  createIauditUser,
  createPasswordResetToken,
  createRefreshToken,
  deleteEmailVerificationToken,
  getActiveRefreshToken,
  getEmailVerificationToken,
  getIauditUserByEmail,
  getIauditUserById,
  getPasswordResetToken,
  markPasswordResetTokenUsed,
  revokeAllRefreshTokensForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  setEmailVerified,
  updatePassword,
} from "../iauth.db";
import {
  generateRefreshToken,
  generateSecureToken,
  generateUUID,
  hashPassword,
  hashRefreshToken,
  refreshTokenExpiresAt,
  resetTokenExpiresAt,
  sendPasswordResetEmail,
  sendVerificationEmail,
  signAccessToken,
  validatePasswordStrength,
  verificationTokenExpiresAt,
  verifyAccessToken,
  verifyPassword,
} from "../iauth.service";

// ---------------------------------------------------------------------------
// Cookie name for the refresh token (HttpOnly, Secure)
// ---------------------------------------------------------------------------
const REFRESH_COOKIE = "iaudit_refresh";

function setRefreshCookie(res: any, rawToken: string, expiresAt: Date) {
  // Use root path so the cookie is sent with all /api/trpc/* requests
  res.cookie(REFRESH_COOKIE, rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    expires: expiresAt,
    path: "/",
  });
}

function clearRefreshCookie(res: any) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
  });
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const registerInput = z.object({
  name: z.string().min(1, "Name is required").max(200),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  // SECURITY: only solo and agency allowed via public form (Section 3 + 4.1)
  accountType: z.enum(["solo", "agency"], {
    message: "Account type must be solo or agency",
  }),
  origin: z.string().url("Invalid origin URL"),
});

const verifyEmailInput = z.object({
  token: z.string().min(1),
});

const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const forgotPasswordInput = z.object({
  email: z.string().email(),
  origin: z.string().url("Invalid origin URL"),
});

const resetPasswordInput = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

const refreshInput = z.object({
  // The raw refresh token — sent from cookie or body
  refreshToken: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const iauthRouter = router({
  /**
   * Register a new user account.
   * - account_type=admin is BLOCKED on this public endpoint.
   * - Sends email verification link via Resend.
   */
  register: publicProcedure.input(registerInput).mutation(async ({ input, ctx }) => {
    // Enforce password strength (Section 4.1)
    const strength = validatePasswordStrength(input.password);
    if (!strength.valid) {
      throw new TRPCError({ code: "BAD_REQUEST", message: strength.reason });
    }

    // Normalise email to lowercase
    const email = input.email.toLowerCase().trim();

    // Check for duplicate email
    const existing = await getIauditUserByEmail(email);
    if (existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "An account with this email address already exists",
      });
    }

    const passwordHash = await hashPassword(input.password);
    const userId = generateUUID();
    const now = new Date();

    await createIauditUser({
      id: userId,
      email,
      passwordHash,
      name: input.name.trim(),
      accountType: input.accountType, // only "solo" | "agency" — admin blocked by zod schema
      emailVerified: false,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: now,
      updatedAt: now,
    });

    // Create email verification token
    const verifyToken = generateSecureToken();
    await createEmailVerificationToken({
      id: generateUUID(),
      userId,
      token: verifyToken,
      expiresAt: verificationTokenExpiresAt(),
    });

    // Send verification email (non-blocking — don't fail registration if email fails)
    try {
      await sendVerificationEmail(email, input.name.trim(), verifyToken, input.origin);
    } catch (err) {
      console.error("[Auth] Failed to send verification email:", err);
      // Registration still succeeds — user can request resend later
    }

    return {
      success: true,
      message: "Account created. Please check your email to verify your address.",
      userId,
    };
  }),

  /**
   * Verify email address using the token from the verification link.
   * Sets email_verified=true and deletes the token.
   */
  verifyEmail: publicProcedure.input(verifyEmailInput).mutation(async ({ input }) => {
    const record = await getEmailVerificationToken(input.token);
    if (!record) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This verification link is invalid or has expired",
      });
    }

    await setEmailVerified(record.userId);
    await deleteEmailVerificationToken(input.token);

    return {
      success: true,
      message: "Email verified successfully. You can now log in.",
      userId: record.userId,
    };
  }),

  /**
   * Login with email + password.
   * Returns a signed JWT access token (15-min) and sets an HttpOnly refresh token cookie (30-day).
   */
  login: publicProcedure.input(loginInput).mutation(async ({ input, ctx }) => {
    const email = input.email.toLowerCase().trim();
    const user = await getIauditUserByEmail(email);

    // Use constant-time comparison to prevent user enumeration
    if (!user) {
      // Still run bcrypt to prevent timing attacks
      await hashPassword("dummy-prevent-timing-attack");
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid email or password",
      });
    }

    const passwordValid = await verifyPassword(input.password, user.passwordHash);
    if (!passwordValid) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid email or password",
      });
    }

    if (user.isSuspended) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "This account has been suspended. Please contact support.",
      });
    }

    if (!user.emailVerified) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Please verify your email address before logging in.",
      });
    }

    // Issue access token (15-min JWT)
    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      accountType: user.accountType,
      emailVerified: user.emailVerified,
    });

    // Issue refresh token (30-day, stored as hash in DB)
    const { raw: rawRefresh, hash: refreshHash } = generateRefreshToken();
    const refreshExpiry = refreshTokenExpiresAt();
    await createRefreshToken({
      id: generateUUID(),
      userId: user.id,
      tokenHash: refreshHash,
      expiresAt: refreshExpiry,
    });

    // Set refresh token as HttpOnly cookie
    setRefreshCookie(ctx.res, rawRefresh, refreshExpiry);

    return {
      success: true,
      accessToken,
      expiresIn: 15 * 60, // seconds
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        accountType: user.accountType,
        emailVerified: user.emailVerified,
        creditsRemaining: user.creditsRemaining,
      },
    };
  }),

  /**
   * Logout — revokes the current refresh token.
   * The access token will naturally expire after 15 minutes.
   */
  logout: publicProcedure.input(refreshInput).mutation(async ({ input, ctx }) => {
    const rawToken =
      input.refreshToken ?? (ctx.req.cookies as Record<string, string>)?.[REFRESH_COOKIE];

    if (rawToken) {
      const tokenHash = hashRefreshToken(rawToken);
      await revokeRefreshToken(tokenHash);
    }

    clearRefreshCookie(ctx.res);

    return { success: true };
  }),

  /**
   * Refresh — rotate the refresh token and issue a new access token.
   * Old refresh token is revoked; new one is issued.
   */
  refresh: publicProcedure.input(refreshInput).mutation(async ({ input, ctx }) => {
    const rawToken =
      input.refreshToken ?? (ctx.req.cookies as Record<string, string>)?.[REFRESH_COOKIE];

    if (!rawToken) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "No refresh token provided" });
    }

    const oldHash = hashRefreshToken(rawToken);
    const record = await getActiveRefreshToken(oldHash);

    if (!record) {
      // Token not found, expired, or already revoked — possible replay attack
      clearRefreshCookie(ctx.res);
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Refresh token is invalid or has expired. Please log in again.",
      });
    }

    const user = await getIauditUserById(record.userId);
    if (!user || user.isSuspended) {
      await revokeAllRefreshTokensForUser(record.userId);
      clearRefreshCookie(ctx.res);
      throw new TRPCError({ code: "FORBIDDEN", message: "Account is suspended" });
    }

    // Rotate: revoke old, issue new
    const { raw: newRaw, hash: newHash } = generateRefreshToken();
    const newExpiry = refreshTokenExpiresAt();

    await rotateRefreshToken(oldHash, {
      id: generateUUID(),
      userId: user.id,
      tokenHash: newHash,
      expiresAt: newExpiry,
    });

    // Issue new access token
    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
      accountType: user.accountType,
      emailVerified: user.emailVerified,
    });

    setRefreshCookie(ctx.res, newRaw, newExpiry);

    return {
      success: true,
      accessToken,
      expiresIn: 15 * 60,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        accountType: user.accountType,
        emailVerified: user.emailVerified,
        creditsRemaining: user.creditsRemaining,
      },
    };
  }),

  /**
   * Forgot password — sends a reset link via Resend (1-hour expiry).
   * Always returns success to prevent user enumeration.
   */
  forgotPassword: publicProcedure
    .input(forgotPasswordInput)
    .mutation(async ({ input }) => {
      const email = input.email.toLowerCase().trim();
      const user = await getIauditUserByEmail(email);

      if (user) {
        const resetToken = generateSecureToken();
        await createPasswordResetToken({
          id: generateUUID(),
          userId: user.id,
          token: resetToken,
          expiresAt: resetTokenExpiresAt(),
        });

        try {
          await sendPasswordResetEmail(email, user.name, resetToken, input.origin);
        } catch (err) {
          console.error("[Auth] Failed to send password reset email:", err);
        }
      }

      // Always return success — prevents email enumeration
      return {
        success: true,
        message:
          "If an account exists with that email address, a password reset link has been sent.",
      };
    }),

  /**
   * Reset password — validates the token, hashes the new password,
   * and invalidates ALL refresh tokens for the user (Section 4.3).
   */
  resetPassword: publicProcedure
    .input(resetPasswordInput)
    .mutation(async ({ input, ctx }) => {
      const strength = validatePasswordStrength(input.newPassword);
      if (!strength.valid) {
        throw new TRPCError({ code: "BAD_REQUEST", message: strength.reason });
      }

      const record = await getPasswordResetToken(input.token);
      if (!record) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This password reset link is invalid or has expired",
        });
      }

      const newHash = await hashPassword(input.newPassword);

      // Update password
      await updatePassword(record.userId, newHash);

      // Mark token as used (single-use)
      await markPasswordResetTokenUsed(input.token);

      // Invalidate ALL refresh tokens for this user (Section 4.3)
      await revokeAllRefreshTokensForUser(record.userId);

      // Clear refresh cookie on this device
      clearRefreshCookie(ctx.res);

      return {
        success: true,
        message: "Password updated successfully. Please log in with your new password.",
      };
    }),

  /**
   * Get the currently authenticated iAudit user from their access token.
   * Used by the frontend to validate session state.
   */
  me: publicProcedure
    .input(z.object({ accessToken: z.string() }))
    .query(async ({ input }) => {
      const payload = await verifyAccessToken(input.accessToken);
      if (!payload) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired access token" });
      }
      const user = await getIauditUserById(payload.sub);
      if (!user || user.isSuspended) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Account not found or suspended" });
      }
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        accountType: user.accountType,
        emailVerified: user.emailVerified,
        creditsRemaining: user.creditsRemaining,
      };
    }),
});
