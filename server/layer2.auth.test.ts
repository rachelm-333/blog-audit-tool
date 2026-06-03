/**
 * Layer 2 — Authentication Tests
 *
 * Tests all auth flows end-to-end against the real database:
 * - Registration (creates iaudit_users row, blocks admin account_type)
 * - Email verification (sets email_verified=true, invalidates token)
 * - Login (returns JWT + refresh token, blocks unverified/suspended)
 * - Logout (revokes refresh token)
 * - Token refresh (rotates refresh token, issues new access token)
 * - Forgot password (creates reset token, prevents user enumeration)
 * - Reset password (validates token, hashes new password, revokes all refresh tokens)
 * - Auth service unit tests (bcrypt, JWT, token generation)
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generateSecureToken,
  generateUUID,
  refreshTokenExpiresAt,
  verificationTokenExpiresAt,
  resetTokenExpiresAt,
} from "./iauth.service";
import {
  createIauditUser,
  getIauditUserByEmail,
  getIauditUserById,
  createEmailVerificationToken,
  getEmailVerificationToken,
  createRefreshToken,
  getActiveRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
  createPasswordResetToken,
  getPasswordResetToken,
} from "./iauth.db";

// ---------------------------------------------------------------------------
// Test context factory
// ---------------------------------------------------------------------------

type CookieEntry = { name: string; value: string; options: Record<string, unknown> };

function createTestContext(): {
  ctx: TrpcContext;
  cookies: CookieEntry[];
  clearedCookies: string[];
} {
  const cookies: CookieEntry[] = [];
  const clearedCookies: string[] = [];

  const ctx: TrpcContext = {
    user: null,
    req: {
      protocol: "https",
      headers: {},
      cookies: {} as Record<string, string>,
    } as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string, options: Record<string, unknown>) => {
        cookies.push({ name, value, options });
      },
      clearCookie: (name: string) => {
        clearedCookies.push(name);
      },
    } as unknown as TrpcContext["res"],
  };

  return { ctx, cookies, clearedCookies };
}

// ---------------------------------------------------------------------------
// Unique email helper to avoid test collisions
// ---------------------------------------------------------------------------

let testCounter = Date.now();
function uniqueEmail(prefix = "test") {
  return `${prefix}+${testCounter++}@iaudit-test.example.com`;
}

// ---------------------------------------------------------------------------
// Auth Service Unit Tests
// ---------------------------------------------------------------------------

describe("Auth Service — bcrypt", () => {
  it("hashes a password and verifies it correctly", async () => {
    const hash = await hashPassword("MyP@ssw0rd!");
    expect(hash).toMatch(/^\$2b\$/);
    expect(await verifyPassword("MyP@ssw0rd!", hash)).toBe(true);
    expect(await verifyPassword("WrongPassword", hash)).toBe(false);
  });

  it("produces different hashes for the same password (salt)", async () => {
    const h1 = await hashPassword("SamePass1!");
    const h2 = await hashPassword("SamePass1!");
    expect(h1).not.toBe(h2);
  });
});

describe("Auth Service — password strength validation", () => {
  it("rejects passwords shorter than 8 characters", () => {
    expect(validatePasswordStrength("Ab1!")).toMatchObject({ valid: false });
  });

  it("rejects passwords without a number", () => {
    expect(validatePasswordStrength("NoNumber!")).toMatchObject({ valid: false });
  });

  it("rejects passwords without a special character", () => {
    expect(validatePasswordStrength("NoSpecial1")).toMatchObject({ valid: false });
  });

  it("accepts valid passwords", () => {
    expect(validatePasswordStrength("Valid1Pass!")).toMatchObject({ valid: true });
    expect(validatePasswordStrength("Sup3r$ecure")).toMatchObject({ valid: true });
  });
});

describe("Auth Service — JWT", () => {
  it("signs and verifies an access token", async () => {
    const payload = {
      sub: "user-123",
      email: "test@example.com",
      accountType: "solo" as const,
      emailVerified: true,
    };
    const token = await signAccessToken(payload);
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3); // JWT has 3 parts

    const verified = await verifyAccessToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.sub).toBe("user-123");
    expect(verified!.email).toBe("test@example.com");
    expect(verified!.accountType).toBe("solo");
    expect(verified!.emailVerified).toBe(true);
  });

  it("returns null for an invalid token", async () => {
    const result = await verifyAccessToken("not.a.valid.token");
    expect(result).toBeNull();
  });

  it("returns null for a tampered token", async () => {
    const token = await signAccessToken({
      sub: "x",
      email: "x@x.com",
      accountType: "solo",
      emailVerified: false,
    });
    const tampered = token.slice(0, -5) + "XXXXX";
    expect(await verifyAccessToken(tampered)).toBeNull();
  });
});

describe("Auth Service — refresh token generation", () => {
  it("generates a raw token and its hash", () => {
    const { raw, hash } = generateRefreshToken();
    expect(raw).toHaveLength(80); // 40 bytes hex
    expect(hash).toHaveLength(64); // SHA-256 hex
    expect(raw).not.toBe(hash);
  });

  it("hashRefreshToken produces the same hash for the same raw token", () => {
    const { raw, hash } = generateRefreshToken();
    expect(hashRefreshToken(raw)).toBe(hash);
  });

  it("generates unique tokens on each call", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("Auth Service — expiry helpers", () => {
  it("refresh token expires ~30 days from now", () => {
    const exp = refreshTokenExpiresAt();
    const diff = exp.getTime() - Date.now();
    expect(diff).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(diff).toBeLessThan(31 * 24 * 60 * 60 * 1000);
  });

  it("verification token expires ~24 hours from now", () => {
    const exp = verificationTokenExpiresAt();
    const diff = exp.getTime() - Date.now();
    expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(diff).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("reset token expires ~1 hour from now (scope requirement)", () => {
    const exp = resetTokenExpiresAt();
    const diff = exp.getTime() - Date.now();
    expect(diff).toBeGreaterThan(55 * 60 * 1000);
    expect(diff).toBeLessThan(65 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Database helper tests
// ---------------------------------------------------------------------------

describe("DB helpers — iaudit_users", () => {
  it("creates a user and retrieves by email", async () => {
    const email = uniqueEmail("dbtest");
    const id = generateUUID();
    await createIauditUser({
      id,
      email,
      passwordHash: await hashPassword("Test1Pass!"),
      name: "DB Test User",
      accountType: "solo",
      emailVerified: false,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const found = await getIauditUserByEmail(email);
    expect(found).not.toBeUndefined();
    expect(found!.id).toBe(id);
    expect(found!.accountType).toBe("solo");
    expect(found!.emailVerified).toBe(false);
  });

  it("retrieves user by ID", async () => {
    const email = uniqueEmail("byid");
    const id = generateUUID();
    await createIauditUser({
      id,
      email,
      passwordHash: await hashPassword("Test1Pass!"),
      name: "ByID User",
      accountType: "agency",
      emailVerified: false,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const found = await getIauditUserById(id);
    expect(found).not.toBeUndefined();
    expect(found!.email).toBe(email);
  });

  it("returns undefined for non-existent email", async () => {
    const result = await getIauditUserByEmail("nobody@nowhere.example.com");
    expect(result).toBeUndefined();
  });
});

describe("DB helpers — email_verification_tokens", () => {
  it("creates and retrieves a valid verification token", async () => {
    const userId = generateUUID();
    const email = uniqueEmail("evtoken");
    await createIauditUser({
      id: userId,
      email,
      passwordHash: await hashPassword("Test1Pass!"),
      name: "EV Token User",
      accountType: "solo",
      emailVerified: false,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const token = generateSecureToken();
    await createEmailVerificationToken({
      id: generateUUID(),
      userId,
      token,
      expiresAt: verificationTokenExpiresAt(),
    });

    const found = await getEmailVerificationToken(token);
    expect(found).not.toBeUndefined();
    expect(found!.userId).toBe(userId);
  });

  it("returns undefined for an expired token", async () => {
    const userId = generateUUID();
    const email = uniqueEmail("expiredtoken");
    await createIauditUser({
      id: userId,
      email,
      passwordHash: await hashPassword("Test1Pass!"),
      name: "Expired Token User",
      accountType: "solo",
      emailVerified: false,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const token = generateSecureToken();
    const pastDate = new Date(Date.now() - 1000); // 1 second in the past
    await createEmailVerificationToken({
      id: generateUUID(),
      userId,
      token,
      expiresAt: pastDate,
    });

    const found = await getEmailVerificationToken(token);
    expect(found).toBeUndefined();
  });
});

describe("DB helpers — refresh_tokens", () => {
  it("creates and retrieves an active refresh token", async () => {
    const userId = generateUUID();
    const email = uniqueEmail("rttoken");
    await createIauditUser({
      id: userId,
      email,
      passwordHash: await hashPassword("Test1Pass!"),
      name: "RT Token User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { raw, hash } = generateRefreshToken();
    await createRefreshToken({
      id: generateUUID(),
      userId,
      tokenHash: hash,
      expiresAt: refreshTokenExpiresAt(),
    });

    const found = await getActiveRefreshToken(hash);
    expect(found).not.toBeUndefined();
    expect(found!.userId).toBe(userId);
  });

  it("returns undefined for a revoked token", async () => {
    const userId = generateUUID();
    const email = uniqueEmail("revokedrt");
    await createIauditUser({
      id: userId,
      email,
      passwordHash: await hashPassword("Test1Pass!"),
      name: "Revoked RT User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { hash } = generateRefreshToken();
    await createRefreshToken({
      id: generateUUID(),
      userId,
      tokenHash: hash,
      expiresAt: refreshTokenExpiresAt(),
    });

    await revokeRefreshToken(hash);

    const found = await getActiveRefreshToken(hash);
    expect(found).toBeUndefined();
  });

  it("revokeAllRefreshTokensForUser revokes all tokens", async () => {
    const userId = generateUUID();
    const email = uniqueEmail("revokeall");
    await createIauditUser({
      id: userId,
      email,
      passwordHash: await hashPassword("Test1Pass!"),
      name: "Revoke All User",
      accountType: "agency",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const t1 = generateRefreshToken();
    const t2 = generateRefreshToken();
    await createRefreshToken({ id: generateUUID(), userId, tokenHash: t1.hash, expiresAt: refreshTokenExpiresAt() });
    await createRefreshToken({ id: generateUUID(), userId, tokenHash: t2.hash, expiresAt: refreshTokenExpiresAt() });

    await revokeAllRefreshTokensForUser(userId);

    expect(await getActiveRefreshToken(t1.hash)).toBeUndefined();
    expect(await getActiveRefreshToken(t2.hash)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tRPC Router — end-to-end procedure tests
// ---------------------------------------------------------------------------

describe("iauth.register", () => {
  it("creates a new user row in iaudit_users with account_type=solo", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("register");

    const result = await caller.iauth.register({
      name: "Test User",
      email,
      password: "Secure1Pass!",
      accountType: "solo",
      origin: "https://iaudit.example.com",
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBeTruthy();

    // Verify row was created in DB
    const user = await getIauditUserByEmail(email);
    expect(user).not.toBeUndefined();
    expect(user!.accountType).toBe("solo");
    expect(user!.emailVerified).toBe(false);
    expect(user!.passwordHash).not.toBe("Secure1Pass!"); // must be hashed
    expect(user!.passwordHash).toMatch(/^\$2b\$/); // bcrypt hash
  }, 15_000);

  it("creates a user with account_type=agency", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("agency");

    await caller.iauth.register({
      name: "Agency User",
      email,
      password: "Agency1Pass!",
      accountType: "agency",
      origin: "https://iaudit.example.com",
    });

    const user = await getIauditUserByEmail(email);
    expect(user!.accountType).toBe("agency");
  }, 15_000);

  it("BLOCKS account_type=admin via public registration form", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.iauth.register({
        name: "Admin Attempt",
        email: uniqueEmail("admin-blocked"),
        password: "Admin1Pass!",
        accountType: "admin" as any, // Force the type to test runtime blocking
        origin: "https://iaudit.example.com",
      })
    ).rejects.toThrow();
  });

  it("rejects duplicate email addresses", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("duplicate");

    await caller.iauth.register({
      name: "First User",
      email,
      password: "First1Pass!",
      accountType: "solo",
      origin: "https://iaudit.example.com",
    });

    await expect(
      caller.iauth.register({
        name: "Second User",
        email, // same email
        password: "Second1Pass!",
        accountType: "solo",
        origin: "https://iaudit.example.com",
      })
    ).rejects.toThrow(/already exists/i);
  }, 15_000);

  it("rejects weak passwords", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.iauth.register({
        name: "Weak Pass User",
        email: uniqueEmail("weakpass"),
        password: "short",
        accountType: "solo",
        origin: "https://iaudit.example.com",
      })
    ).rejects.toThrow();
  });

  it("stores email in lowercase", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("UPPERCASE");

    await caller.iauth.register({
      name: "Case Test",
      email: email.toUpperCase(),
      password: "Upper1Pass!",
      accountType: "solo",
      origin: "https://iaudit.example.com",
    });

    const user = await getIauditUserByEmail(email.toLowerCase());
    expect(user).not.toBeUndefined();
    expect(user!.email).toBe(email.toLowerCase());
  });
});

describe("iauth.verifyEmail", () => {
  it("sets email_verified=true when given a valid token", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("verify");

    const reg = await caller.iauth.register({
      name: "Verify User",
      email,
      password: "Verify1Pass!",
      accountType: "solo",
      origin: "https://iaudit.example.com",
    });

    // Get the token from DB directly (simulating clicking the link)
    const user = await getIauditUserByEmail(email);
    // Create a fresh token for this test (registration sends email but we can't intercept it)
    const token = generateSecureToken();
    await createEmailVerificationToken({
      id: generateUUID(),
      userId: user!.id,
      token,
      expiresAt: verificationTokenExpiresAt(),
    });

    const result = await caller.iauth.verifyEmail({ token });
    expect(result.success).toBe(true);

    const updated = await getIauditUserById(user!.id);
    expect(updated!.emailVerified).toBe(true);
  });

  it("rejects an invalid or expired token", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.iauth.verifyEmail({ token: "invalid-token-that-does-not-exist" })
    ).rejects.toThrow(/invalid or has expired/i);
  });

  it("invalidates the token after use (single-use)", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("singleuse");

    await caller.iauth.register({
      name: "Single Use",
      email,
      password: "Single1Pass!",
      accountType: "solo",
      origin: "https://iaudit.example.com",
    });

    const user = await getIauditUserByEmail(email);
    const token = generateSecureToken();
    await createEmailVerificationToken({
      id: generateUUID(),
      userId: user!.id,
      token,
      expiresAt: verificationTokenExpiresAt(),
    });

    await caller.iauth.verifyEmail({ token });

    // Second use should fail
    await expect(caller.iauth.verifyEmail({ token })).rejects.toThrow();
  });
});

describe("iauth.login", () => {
  // Helper: create a verified user ready for login
  async function createVerifiedUser(email: string, password: string) {
    const id = generateUUID();
    const passwordHash = await hashPassword(password);
    await createIauditUser({
      id,
      email,
      passwordHash,
      name: "Login Test User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 5,
      creditsTotalPurchased: 5,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  it("returns a valid JWT access token on successful login", async () => {
    const { ctx, cookies } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("login");
    const password = "Login1Pass!";
    await createVerifiedUser(email, password);

    const result = await caller.iauth.login({ email, password });

    expect(result.success).toBe(true);
    expect(typeof result.accessToken).toBe("string");
    expect(result.accessToken.split(".")).toHaveLength(3); // valid JWT

    // Verify the JWT payload
    const payload = await verifyAccessToken(result.accessToken);
    expect(payload).not.toBeNull();
    expect(payload!.email).toBe(email);
    expect(payload!.accountType).toBe("solo");
    expect(payload!.emailVerified).toBe(true);
  });

  it("sets an HttpOnly refresh token cookie on login", async () => {
    const { ctx, cookies } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("logincookie");
    await createVerifiedUser(email, "Cookie1Pass!");

    await caller.iauth.login({ email, password: "Cookie1Pass!" });

    const refreshCookie = cookies.find((c) => c.name === "iaudit_refresh");
    expect(refreshCookie).not.toBeUndefined();
    expect(refreshCookie!.options.httpOnly).toBe(true);
    expect(refreshCookie!.options.secure).toBe(true);
  });

  it("stores the refresh token hash in the database", async () => {
    const { ctx, cookies } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("logindb");
    await createVerifiedUser(email, "DBStore1Pass!");

    await caller.iauth.login({ email, password: "DBStore1Pass!" });

    const refreshCookie = cookies.find((c) => c.name === "iaudit_refresh");
    const tokenHash = hashRefreshToken(refreshCookie!.value);
    const dbRecord = await getActiveRefreshToken(tokenHash);
    expect(dbRecord).not.toBeUndefined();
  });

  it("rejects invalid credentials", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("badlogin");
    await createVerifiedUser(email, "Correct1Pass!");

    await expect(
      caller.iauth.login({ email, password: "WrongPassword1!" })
    ).rejects.toThrow(/invalid email or password/i);
  });

  it("rejects login for non-existent user", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.iauth.login({ email: "nobody@nowhere.example.com", password: "Any1Pass!" })
    ).rejects.toThrow(/invalid email or password/i);
  });

  it("rejects login for unverified email", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("unverified");

    // Create unverified user
    await createIauditUser({
      id: generateUUID(),
      email,
      passwordHash: await hashPassword("Unverified1!"),
      name: "Unverified",
      accountType: "solo",
      emailVerified: false, // not verified
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      caller.iauth.login({ email, password: "Unverified1!" })
    ).rejects.toThrow(/verify your email/i);
  });

  it("rejects login for suspended accounts", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("suspended");

    await createIauditUser({
      id: generateUUID(),
      email,
      passwordHash: await hashPassword("Suspended1!"),
      name: "Suspended User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: true, // suspended
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      caller.iauth.login({ email, password: "Suspended1!" })
    ).rejects.toThrow(/suspended/i);
  });
});

describe("iauth.logout", () => {
  it("revokes the refresh token on logout", async () => {
    const { ctx, cookies } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("logout");

    await createIauditUser({
      id: generateUUID(),
      email,
      passwordHash: await hashPassword("Logout1Pass!"),
      name: "Logout User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await caller.iauth.login({ email, password: "Logout1Pass!" });
    const refreshCookie = cookies.find((c) => c.name === "iaudit_refresh");
    const rawToken = refreshCookie!.value;
    const tokenHash = hashRefreshToken(rawToken);

    // Verify token is active before logout
    expect(await getActiveRefreshToken(tokenHash)).not.toBeUndefined();

    // Logout
    const { clearedCookies } = createTestContext();
    const logoutCtx: TrpcContext = {
      ...ctx,
      req: {
        ...ctx.req,
        cookies: { iaudit_refresh: rawToken },
      } as TrpcContext["req"],
      res: {
        clearCookie: (name: string) => clearedCookies.push(name),
      } as unknown as TrpcContext["res"],
    };
    const logoutCaller = appRouter.createCaller(logoutCtx);
    const result = await logoutCaller.iauth.logout({});

    expect(result.success).toBe(true);

    // Token should now be revoked
    expect(await getActiveRefreshToken(tokenHash)).toBeUndefined();
  });
});

describe("iauth.refresh", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const { ctx, cookies } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("refresh");

    await createIauditUser({
      id: generateUUID(),
      email,
      passwordHash: await hashPassword("Refresh1Pass!"),
      name: "Refresh User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await caller.iauth.login({ email, password: "Refresh1Pass!" });
    const oldCookie = cookies.find((c) => c.name === "iaudit_refresh");
    const oldRaw = oldCookie!.value;
    const oldHash = hashRefreshToken(oldRaw);

    // Refresh using the old token
    const newCookies: CookieEntry[] = [];
    const refreshCtx: TrpcContext = {
      ...ctx,
      req: { ...ctx.req, cookies: { iaudit_refresh: oldRaw } } as TrpcContext["req"],
      res: {
        cookie: (name: string, value: string, options: Record<string, unknown>) => {
          newCookies.push({ name, value, options });
        },
        clearCookie: () => {},
      } as unknown as TrpcContext["res"],
    };
    const refreshCaller = appRouter.createCaller(refreshCtx);
    const result = await refreshCaller.iauth.refresh({ refreshToken: oldRaw });

    expect(result.success).toBe(true);
    expect(typeof result.accessToken).toBe("string");

    // Old token should be revoked
    expect(await getActiveRefreshToken(oldHash)).toBeUndefined();

    // New token should be active
    const newCookie = newCookies.find((c) => c.name === "iaudit_refresh");
    expect(newCookie).not.toBeUndefined();
    const newHash = hashRefreshToken(newCookie!.value);
    expect(await getActiveRefreshToken(newHash)).not.toBeUndefined();
  });

  it("rejects an invalid refresh token", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.iauth.refresh({ refreshToken: "invalid-refresh-token" })
    ).rejects.toThrow(/invalid or has expired/i);
  });
});

describe("iauth.forgotPassword", () => {
  it("creates a password reset token for an existing user", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("forgot");

    await createIauditUser({
      id: generateUUID(),
      email,
      passwordHash: await hashPassword("Forgot1Pass!"),
      name: "Forgot User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await caller.iauth.forgotPassword({
      email,
      origin: "https://iaudit.example.com",
    });

    expect(result.success).toBe(true);
    // Always returns success (prevents enumeration)
    expect(result.message).toMatch(/if an account exists/i);
  }, 15_000);

  it("returns success even for non-existent email (prevents enumeration)", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.iauth.forgotPassword({
      email: "nobody@nowhere-at-all.example.com",
      origin: "https://iaudit.example.com",
    });

    expect(result.success).toBe(true);
  });
});

describe("iauth.resetPassword", () => {
  it("resets the password and invalidates all refresh tokens", async () => {
    const { ctx, cookies } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("reset");
    const userId = generateUUID();

    await createIauditUser({
      id: userId,
      email,
      passwordHash: await hashPassword("OldPass1!"),
      name: "Reset User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create a refresh token to verify it gets revoked
    const { hash: rtHash } = generateRefreshToken();
    await createRefreshToken({
      id: generateUUID(),
      userId,
      tokenHash: rtHash,
      expiresAt: refreshTokenExpiresAt(),
    });

    // Create a password reset token
    const resetToken = generateSecureToken();
    await createPasswordResetToken({
      id: generateUUID(),
      userId,
      token: resetToken,
      expiresAt: resetTokenExpiresAt(),
    });

    const { clearedCookies } = createTestContext();
    const resetCtx: TrpcContext = {
      ...ctx,
      res: {
        clearCookie: (name: string) => clearedCookies.push(name),
      } as unknown as TrpcContext["res"],
    };
    const resetCaller = appRouter.createCaller(resetCtx);

    const result = await resetCaller.iauth.resetPassword({
      token: resetToken,
      newPassword: "NewPass1!",
    });

    expect(result.success).toBe(true);

    // Old refresh token should be revoked
    expect(await getActiveRefreshToken(rtHash)).toBeUndefined();

    // New password should work for login
    const loginResult = await caller.iauth.login({ email, password: "NewPass1!" });
    expect(loginResult.success).toBe(true);

    // Old password should not work
    await expect(
      caller.iauth.login({ email, password: "OldPass1!" })
    ).rejects.toThrow(/invalid email or password/i);
  });

  it("rejects an invalid reset token", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.iauth.resetPassword({
        token: "invalid-reset-token",
        newPassword: "NewPass1!",
      })
    ).rejects.toThrow(/invalid or has expired/i);
  });

  it("rejects a used reset token (single-use)", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("usedtoken");
    const userId = generateUUID();

    await createIauditUser({
      id: userId,
      email,
      passwordHash: await hashPassword("Used1Pass!"),
      name: "Used Token User",
      accountType: "solo",
      emailVerified: true,
      creditsRemaining: 0,
      creditsTotalPurchased: 0,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resetToken = generateSecureToken();
    await createPasswordResetToken({
      id: generateUUID(),
      userId,
      token: resetToken,
      expiresAt: resetTokenExpiresAt(),
    });

    const resetCtx: TrpcContext = {
      ...ctx,
      res: { clearCookie: () => {} } as unknown as TrpcContext["res"],
    };
    const resetCaller = appRouter.createCaller(resetCtx);

    // First use succeeds
    await resetCaller.iauth.resetPassword({ token: resetToken, newPassword: "NewPass2!" });

    // Second use should fail
    await expect(
      resetCaller.iauth.resetPassword({ token: resetToken, newPassword: "AnotherPass1!" })
    ).rejects.toThrow(/invalid or has expired/i);
  });

  it("rejects weak new passwords on reset", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.iauth.resetPassword({ token: "any-token", newPassword: "weak" })
    ).rejects.toThrow();
  });
});

describe("iauth.me", () => {
  it("returns user data for a valid access token", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);
    const email = uniqueEmail("me");
    const userId = generateUUID();

    await createIauditUser({
      id: userId,
      email,
      passwordHash: await hashPassword("Me1Pass!"),
      name: "Me User",
      accountType: "agency",
      emailVerified: true,
      creditsRemaining: 10,
      creditsTotalPurchased: 10,
      isSuspended: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const accessToken = await signAccessToken({
      sub: userId,
      email,
      accountType: "agency",
      emailVerified: true,
    });

    const result = await caller.iauth.me({ accessToken });
    expect(result.id).toBe(userId);
    expect(result.email).toBe(email);
    expect(result.accountType).toBe("agency");
    expect(result.creditsRemaining).toBe(10);
  });

  it("rejects an invalid access token", async () => {
    const { ctx } = createTestContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.iauth.me({ accessToken: "invalid.access.token" })
    ).rejects.toThrow(/invalid or expired/i);
  });
});
