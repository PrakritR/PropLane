#!/usr/bin/env node
/**
 * Validate Stripe env vars for test or live mode (all keys must match the same mode).
 *
 * Usage:
 *   node --env-file=.env.local scripts/stripe-validate-env.mjs
 *   node --env-file=.env.local scripts/stripe-validate-env.mjs --expect-live
 */

import Stripe from "stripe";

const EXPECT_LIVE = process.argv.includes("--expect-live");

function modeFromSecret(key) {
  if (!key) return null;
  if (key.includes("_test_")) return "test";
  if (key.includes("_live_")) return "live";
  return "unknown";
}

function modeFromPublishable(key) {
  if (!key) return null;
  if (key.startsWith("pk_test_")) return "test";
  if (key.startsWith("pk_live_")) return "live";
  return "unknown";
}

const secret = process.env.STRIPE_SECRET_KEY?.trim();
const publishable = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
const webhook = process.env.STRIPE_WEBHOOK_SECRET?.trim();

const priceKeys = [
  "STRIPE_PRICE_PRO_MONTHLY",
  "STRIPE_PRICE_PRO_ANNUAL",
  "STRIPE_PRICE_BUSINESS_MONTHLY",
  "STRIPE_PRICE_BUSINESS_ANNUAL",
];

let failed = false;

function fail(msg) {
  console.error(`✗ ${msg}`);
  failed = true;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

if (!secret?.startsWith("sk_")) fail("STRIPE_SECRET_KEY missing or invalid");
if (!publishable?.startsWith("pk_")) fail("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY missing or invalid");
if (!webhook?.startsWith("whsec_")) fail("STRIPE_WEBHOOK_SECRET missing or invalid");
const connectWebhook = process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim();
if (connectWebhook && !connectWebhook.startsWith("whsec_")) fail("STRIPE_CONNECT_WEBHOOK_SECRET invalid");
else if (!connectWebhook) console.warn("! STRIPE_CONNECT_WEBHOOK_SECRET not set: connected-account events (account.updated, payout.*) will be rejected. See docs/stripe-go-live.md section 5.");

const secretMode = modeFromSecret(secret);
const publishableMode = modeFromPublishable(publishable);

if (secretMode && publishableMode && secretMode !== publishableMode) {
  fail(`Key mode mismatch: secret is ${secretMode}, publishable is ${publishableMode}`);
} else if (secretMode) {
  ok(`Stripe mode: ${secretMode}${secretMode === "test" ? " (TEST MODE badge will show at checkout)" : " (live payments)"}`);
}

if (EXPECT_LIVE && secretMode !== "live") {
  fail("Expected live keys (--expect-live) but STRIPE_SECRET_KEY is not sk_live_…");
}

for (const key of priceKeys) {
  if (!process.env[key]?.trim()) fail(`${key} is not set`);
}

if (failed) {
  console.error("\nFix the issues above, then restart the dev server / redeploy.");
  process.exit(1);
}

const stripe = new Stripe(secret);
const account = await stripe.accounts.retrieve();
ok(`Stripe account: ${account.settings?.dashboard?.display_name ?? account.id}`);

for (const envKey of priceKeys) {
  const priceId = process.env[envKey].trim();
  try {
    const price = await stripe.prices.retrieve(priceId);
    if (!price.active) fail(`${envKey} (${priceId}) is inactive`);
    else {
      const amt = price.unit_amount != null ? `$${(price.unit_amount / 100).toFixed(2)}` : "?";
      ok(`${envKey}: ${priceId} (${amt}/${price.recurring?.interval ?? "?"})`);
    }
  } catch (err) {
    fail(`${envKey} (${priceId}) — ${err.message}`);
  }
}

if (secretMode === "live") {
  console.log("\nLive mode checklist:");
  console.log("  • Webhook endpoint uses LIVE signing secret from Dashboard (not stripe listen)");
  console.log("  • NEXT_PUBLIC_APP_URL matches your production domain");
  console.log("  • Vercel/hosting env vars updated and redeployed");
  console.log("  • Stripe Dashboard → Settings → Billing → Customer portal enabled");
  console.log("  • Stripe Dashboard → Settings → Payment methods → Apple Pay enabled");
  console.log("  • Run: node --env-file=.env.local scripts/setup-stripe-apple-pay-domains.mjs");
  console.log("  • Stripe account activation / payouts completed");
} else {
  console.log("\nStill in test mode. To accept real payments:");
  console.log("  1. Stripe Dashboard → turn OFF Test mode");
  console.log("  2. Create live Pro/Business prices (or npm run stripe:setup-plans with sk_live_ in .env.local)");
  console.log("  3. Replace all Stripe env vars with live keys + live price IDs + live webhook secret");
  console.log("  4. Update Vercel env and redeploy");
  console.log("  5. Run: node --env-file=.env.local scripts/stripe-validate-env.mjs --expect-live");
}

process.exit(failed ? 1 : 0);
