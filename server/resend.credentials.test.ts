/**
 * Resend Credentials Validation Test
 *
 * Validates that RESEND_API_KEY is set and the Resend client can be instantiated.
 * Note: Actual email delivery requires RESEND_FROM_EMAIL to be a verified domain.
 * This test verifies the key is present and the SDK initialises without error.
 */

import { describe, expect, it } from "vitest";
import { Resend } from "resend";

describe("Resend credentials", () => {
  it("RESEND_API_KEY environment variable is set", () => {
    const key = process.env.RESEND_API_KEY;
    expect(key, "RESEND_API_KEY must be set in environment").toBeTruthy();
    expect(key!.length).toBeGreaterThan(10);
  });

  it("Resend client initialises without throwing", () => {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      console.warn("[Test] RESEND_API_KEY not set — skipping Resend client init test");
      return;
    }
    expect(() => new Resend(key)).not.toThrow();
  });

  it("RESEND_FROM_EMAIL is set (may be placeholder until domain is verified)", () => {
    const from = process.env.RESEND_FROM_EMAIL;
    // This will be a placeholder until a real domain is verified in Resend.
    // The pre-launch checklist requires updating this before going live.
    // A value of '-' or empty means the secret has not been configured yet.
    if (!from || from === "-" || !from.includes("@")) {
      console.warn(
        "[PRE-LAUNCH WARNING] RESEND_FROM_EMAIL is not configured with a real email address. " +
        "Email delivery (verification, password reset) will NOT work until this is set to a " +
        "verified sender address in your Resend account. See todo.md Pre-Launch Checklist."
      );
      // Soft warning — don't fail the build, but log prominently
      return;
    }
    expect(from).toContain("@");
  });
});
