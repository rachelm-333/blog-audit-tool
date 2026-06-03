/**
 * stripe.service.ts — Layer 12
 *
 * Stripe integration for iAudit credit purchases.
 * Test mode only — live keys are activated by Rachel when ready.
 *
 * Credit packs (Section 17.1):
 *   Starter  — 10 credits  — $19 AUD
 *   Standard — 50 credits  — $79 AUD  (Best Value)
 *   Business — 100 credits — $139 AUD
 *   Agency   — 500 credits — $599 AUD
 *
 * All prices include GST (Section 17.3).
 */

import Stripe from "stripe";
import { getStripeCustomerId, setStripeCustomerId } from "./credits.db";

// ---------------------------------------------------------------------------
// Credit pack definitions
// ---------------------------------------------------------------------------

export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceAud: number; // in dollars (inc. GST)
  priceAudCents: number; // in cents for Stripe
  perPostPrice: string; // display string e.g. "$1.90"
  isBestValue: boolean;
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "starter",
    name: "Starter",
    credits: 10,
    priceAud: 19,
    priceAudCents: 1900,
    perPostPrice: "$1.90",
    isBestValue: false,
  },
  {
    id: "standard",
    name: "Standard",
    credits: 50,
    priceAud: 79,
    priceAudCents: 7900,
    perPostPrice: "$1.58",
    isBestValue: true,
  },
  {
    id: "business",
    name: "Business",
    credits: 100,
    priceAud: 139,
    priceAudCents: 13900,
    perPostPrice: "$1.39",
    isBestValue: false,
  },
  {
    id: "agency",
    name: "Agency",
    credits: 500,
    priceAud: 599,
    priceAudCents: 59900,
    perPostPrice: "$1.20",
    isBestValue: false,
  },
];

// ---------------------------------------------------------------------------
// Stripe client
// ---------------------------------------------------------------------------

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY environment variable is not set");
  return new Stripe(key, { apiVersion: "2026-05-27.dahlia" });
}

// ---------------------------------------------------------------------------
// Customer management
// ---------------------------------------------------------------------------

/**
 * Returns existing Stripe customer ID or creates a new one.
 * Stores the customer ID on the iaudit_users row for future purchases.
 */
export async function getOrCreateStripeCustomer(
  userId: string,
  email: string,
  name: string
): Promise<string> {
  // Check if we already have a customer ID
  const existing = await getStripeCustomerId(userId);
  if (existing) return existing;

  // Create a new Stripe customer
  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    name,
    metadata: { iaudit_user_id: userId },
  });

  // Persist for future purchases
  await setStripeCustomerId(userId, customer.id);
  return customer.id;
}

// ---------------------------------------------------------------------------
// Checkout session
// ---------------------------------------------------------------------------

export async function createCheckoutSession(params: {
  userId: string;
  userEmail: string;
  userName: string;
  packId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const pack = CREDIT_PACKS.find((p) => p.id === params.packId);
  if (!pack) throw new Error(`Unknown credit pack: ${params.packId}`);

  const stripe = getStripe();
  const stripeCustomerId = await getOrCreateStripeCustomer(
    params.userId,
    params.userEmail,
    params.userName
  );

  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    payment_method_types: ["card"],
    mode: "payment",
    currency: "aud",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "aud",
          unit_amount: pack.priceAudCents,
          product_data: {
            name: `iAudit ${pack.name} Pack — ${pack.credits} Credits`,
            description: `${pack.credits} blog post rewrites. ${pack.perPostPrice} per post. Credits never expire. All prices include GST.`,
          },
        },
      },
    ],
    client_reference_id: params.userId,
    metadata: {
      user_id: params.userId,
      pack_id: pack.id,
      pack_name: pack.name,
      credits: String(pack.credits),
      customer_email: params.userEmail,
      customer_name: params.userName,
    },
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    allow_promotion_codes: true,
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return session.url;
}

// ---------------------------------------------------------------------------
// Webhook event verification
// ---------------------------------------------------------------------------

export function constructWebhookEvent(
  payload: Buffer,
  signature: string
): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret)
    throw new Error("STRIPE_WEBHOOK_SECRET environment variable is not set");
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}

// ---------------------------------------------------------------------------
// Pack lookup helper (used by frontend)
// ---------------------------------------------------------------------------

export function getCreditPacks(): CreditPack[] {
  return CREDIT_PACKS;
}
