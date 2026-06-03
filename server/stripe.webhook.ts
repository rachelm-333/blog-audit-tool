/**
 * stripe.webhook.ts — Layer 12
 *
 * Express raw-body webhook handler for Stripe events.
 * Must be registered BEFORE express.json() in server/_core/index.ts.
 *
 * Handles:
 *   checkout.session.completed → increment credits, log transaction, send reminder emails
 */

import type { Request, Response } from "express";
import Stripe from "stripe";
import { constructWebhookEvent, CREDIT_PACKS } from "./stripe.service";
import {
  incrementCredits,
  getUserById,
  getUserByStripeCustomerId,
  getCreditsRemainingForUser,
} from "./credits.db";
import { Resend } from "resend";

// ---------------------------------------------------------------------------
// Email helpers
// ---------------------------------------------------------------------------

function getResendClient(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[Stripe Webhook] RESEND_API_KEY not set — skipping reminder email");
    return null as unknown as Resend;
  }
  return new Resend(key);
}

function getFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL ?? "noreply@iaudit.com.au";
}

async function sendLowCreditEmail(
  to: string,
  name: string,
  threshold: 3 | 0,
  origin: string
): Promise<void> {
  const resend = getResendClient();
  if (!resend) return;

  const subject =
    threshold === 3
      ? "You have 3 rewrites remaining — top up now"
      : "You have used all your credits";

  const body =
    threshold === 3
      ? `<p>Hi ${name},</p>
         <p>You have <strong>3 rewrites remaining</strong> — top up now to keep fixing posts.</p>
         <p><a href="${origin}/credits" style="display:inline-block;background:#1A7A4A;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Buy More Credits</a></p>`
      : `<p>Hi ${name},</p>
         <p>You have <strong>used all your credits</strong>. Buy more to continue rewriting posts.</p>
         <p><a href="${origin}/credits" style="display:inline-block;background:#1A7A4A;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Buy More Credits</a></p>`;

  await resend.emails.send({
    from: getFromEmail(),
    to,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">${body}</div>`,
  });
}

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------

export async function handleStripeWebhook(
  req: Request,
  res: Response
): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (!signature) {
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(req.body as Buffer, signature as string);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Stripe Webhook] Signature verification failed:", msg);
    res.status(400).json({ error: `Webhook signature verification failed: ${msg}` });
    return;
  }

  // ── Test event passthrough (required for Stripe test webhook verification) ──
  if (event.id.startsWith("evt_test_")) {
    console.log("[Stripe Webhook] Test event detected, returning verification response");
    res.json({ verified: true });
    return;
  }

  console.log(`[Stripe Webhook] Received event: ${event.type} (${event.id})`);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      await handleCheckoutCompleted(session);
    }
    // Other event types (refunds, disputes) can be handled here in future layers
    res.json({ received: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Stripe Webhook] Error processing event:", msg);
    // Return 200 to prevent Stripe retrying — log the error instead
    res.json({ received: true, warning: msg });
  }
}

// ---------------------------------------------------------------------------
// checkout.session.completed handler
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  const metadata = session.metadata ?? {};
  const userId = metadata.user_id ?? session.client_reference_id;
  const packId = metadata.pack_id;
  const packName = metadata.pack_name ?? packId ?? "Unknown Pack";
  const creditsStr = metadata.credits;

  if (!userId) {
    console.error("[Stripe Webhook] No user_id in checkout session metadata");
    return;
  }

  // Resolve credit amount from metadata or pack definition
  let credits = creditsStr ? parseInt(creditsStr, 10) : 0;
  if (!credits || isNaN(credits)) {
    const pack = CREDIT_PACKS.find((p) => p.id === packId);
    if (!pack) {
      console.error(`[Stripe Webhook] Unknown pack_id: ${packId}`);
      return;
    }
    credits = pack.credits;
  }

  // Resolve payment intent ID
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id ?? session.id;

  console.log(
    `[Stripe Webhook] Incrementing ${credits} credits for user ${userId} (pack: ${packName})`
  );

  // Record credits before increment (for threshold detection)
  const user = await getUserById(userId);
  if (!user) {
    console.error(`[Stripe Webhook] User not found: ${userId}`);
    return;
  }
  const creditsBefore = user.creditsRemaining;

  // Increment credits and log transaction
  await incrementCredits(userId, credits, paymentIntentId, packName);

  console.log(
    `[Stripe Webhook] Credits incremented. User ${user.email}: ${creditsBefore} → ${creditsBefore + credits}`
  );
}

// ---------------------------------------------------------------------------
// Top-up reminder email trigger
// Called by rewrite.db.ts after deducting a credit (Layer 7 integration point)
// ---------------------------------------------------------------------------

/**
 * Check if a credit deduction has crossed a reminder threshold and send email.
 * Thresholds: 3 and 0. Each sends once per crossing (not repeatedly).
 * The "once per crossing" logic is handled by the caller checking the balance
 * before and after deduction — if it crossed the threshold, send.
 */
export async function maybeSendCreditReminderEmail(
  userId: string,
  creditsBefore: number,
  creditsAfter: number,
  origin: string = "https://iaudit.com.au"
): Promise<void> {
  const user = await getUserById(userId);
  if (!user) return;

  // Threshold 3: crossed if before > 3 and after <= 3 (but after > 0)
  if (creditsBefore > 3 && creditsAfter <= 3 && creditsAfter > 0) {
    try {
      await sendLowCreditEmail(user.email, user.name, 3, origin);
      console.log(`[Credits] Sent 3-credit reminder to ${user.email}`);
    } catch (err) {
      console.error("[Credits] Failed to send 3-credit reminder:", err);
    }
  }

  // Threshold 0: crossed if before > 0 and after === 0
  if (creditsBefore > 0 && creditsAfter === 0) {
    try {
      await sendLowCreditEmail(user.email, user.name, 0, origin);
      console.log(`[Credits] Sent 0-credit reminder to ${user.email}`);
    } catch (err) {
      console.error("[Credits] Failed to send 0-credit reminder:", err);
    }
  }
}
