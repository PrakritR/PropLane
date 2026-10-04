#!/usr/bin/env node
/**
 * Idempotently create (or verify) PropLane plan subscription prices in Stripe.
 *
 * Usage:
 *   node --env-file=.env.local scripts/setup-stripe-plan-prices.mjs
 *   node --env-file=.env.local scripts/setup-stripe-plan-prices.mjs --write-env
 *
 * Requires STRIPE_SECRET_KEY (sk_test_… for sandbox, sk_live_… for real payments).
 */

import Stripe from "stripe";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import floorPrices from "../src/lib/billing/manager-floor-prices.json" with { type: "json" };

const WRITE_ENV = process.argv.includes("--write-env");

const PLAN_CATALOG = [
  {
    productName: "PropLane Free",
    productKey: "axis_free",
    envMonthly: "STRIPE_PRICE_FREE_MONTHLY",
    monthlyUsd: floorPrices.free.monthlyCents / 100,
    freeOnly: true,
  },
  {
    productName: "PropLane Pro",
    productKey: "axis_pro",
    envMonthly: "STRIPE_PRICE_PRO_MONTHLY",
    envAnnual: "STRIPE_PRICE_PRO_ANNUAL",
    monthlyUsd: floorPrices.pro.monthlyCents / 100,
    annualUsd: floorPrices.pro.annualCents / 100,
  },
  {
    productName: "PropLane Business",
    productKey: "axis_business",
    envMonthly: "STRIPE_PRICE_BUSINESS_MONTHLY",
    envAnnual: "STRIPE_PRICE_BUSINESS_ANNUAL",
    monthlyUsd: floorPrices.business.monthlyCents / 100,
    annualUsd: floorPrices.business.annualCents / 100,
  },
];

function usdToCents(usd) {
  return Math.round(usd * 100);
}

function priceMatches(price, expectedUsd, interval, productId) {
  return (
    price.active &&
    price.currency === "usd" &&
    price.unit_amount === usdToCents(expectedUsd) &&
    price.recurring?.interval === interval &&
    price.recurring?.interval_count === 1 &&
    (!productId || (typeof price.product === "string" ? price.product : price.product?.id) === productId)
  );
}

async function findProductByMetadata(stripe, key) {
  const listed = await stripe.products.list({ limit: 100, active: true });
  return listed.data.find((p) => p.metadata?.axis_plan === key) ?? null;
}

async function ensureProduct(stripe, name, key) {
  const existing = await findProductByMetadata(stripe, key);
  if (existing) {
    if (existing.name !== name) return stripe.products.update(existing.id, { name });
    return existing;
  }
  return stripe.products.create({
    name,
    metadata: { axis_plan: key },
  });
}

async function ensurePrice(stripe, productId, amountUsd, interval, lookupKey) {
  const listed = await stripe.prices.list({ product: productId, limit: 100, active: true });
  const match = listed.data.find((p) => priceMatches(p, amountUsd, interval, productId));
  if (match) {
    if (match.lookup_key !== lookupKey) {
      await stripe.prices.update(match.id, { lookup_key: lookupKey, transfer_lookup_key: true });
      console.log(`  + set lookup_key ${lookupKey} on ${match.id}`);
    }
    return match;
  }
  return stripe.prices.create({
    product: productId,
    currency: "usd",
    unit_amount: usdToCents(amountUsd),
    recurring: { interval },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
  });
}

async function ensureLookupKey(stripe, priceId, lookupKey, label) {
  if (!priceId) return;
  const price = await stripe.prices.retrieve(priceId);
  if (price.lookup_key === lookupKey) return;
  await stripe.prices.update(priceId, { lookup_key: lookupKey, transfer_lookup_key: true });
  console.log(`  + set lookup_key ${lookupKey} on ${label} (${priceId})`);
}

async function verifyExistingPrice(stripe, priceId, amountUsd, interval, label, productId) {
  if (!priceId) return null;
  try {
    const price = await stripe.prices.retrieve(priceId);
    if (!priceMatches(price, amountUsd, interval, productId)) {
      console.warn(
        `  ⚠ ${label} (${priceId}) exists but amount/interval mismatch — expected $${amountUsd}/${interval}.`,
      );
      return null;
    }
    console.log(`  ✓ ${label}: ${priceId} ($${amountUsd}/${interval})`);
    return priceId;
  } catch (err) {
    console.warn(`  ⚠ ${label} (${priceId}) not found in Stripe — will create.`);
    return null;
  }
}

function upsertEnvLines(content, entries) {
  let next = content;
  for (const [key, value] of Object.entries(entries)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}\\s*=.*$`, "m");
    if (re.test(next)) {
      next = next.replace(re, line);
    } else {
      next = `${next.trimEnd()}\n${line}\n`;
    }
  }
  return next;
}

async function main() {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret?.startsWith("sk_")) {
    console.error("Missing STRIPE_SECRET_KEY (sk_test_… or sk_live_…).");
    process.exit(1);
  }

  const stripe = new Stripe(secret);
  const mode = secret.includes("_test_") ? "test" : "live";
  if (mode === "live" && !process.argv.includes("--allow-live")) {
    throw new Error("Live Stripe price setup requires an explicit --allow-live flag.");
  }
  console.log(`Stripe plan setup (${mode} mode)\n`);

  const envOut = {};

  for (const plan of PLAN_CATALOG) {
    console.log(plan.productName);
    const product = await ensureProduct(stripe, plan.productName, plan.productKey);

    if (plan.freeOnly) {
      let freeId = await verifyExistingPrice(
        stripe,
        process.env[plan.envMonthly]?.trim(),
        plan.monthlyUsd,
        "month",
        plan.envMonthly,
        product.id,
      );
      if (!freeId) {
        const price = await ensurePrice(
          stripe,
          product.id,
          plan.monthlyUsd,
          "month",
          "axis_manager_free_monthly",
        );
        freeId = price.id;
        console.log(`  + created ${plan.envMonthly}: ${freeId}`);
      }
      envOut[plan.envMonthly] = freeId;
      await ensureLookupKey(stripe, freeId, "axis_manager_free_monthly", plan.envMonthly);
      console.log("");
      continue;
    }

    let monthlyId = await verifyExistingPrice(
      stripe,
      process.env[plan.envMonthly]?.trim(),
      plan.monthlyUsd,
      "month",
      plan.envMonthly,
      product.id,
    );
    let annualId = await verifyExistingPrice(
      stripe,
      process.env[plan.envAnnual]?.trim(),
      plan.annualUsd,
      "year",
      plan.envAnnual,
      product.id,
    );

    if (!monthlyId || !annualId) {
      if (!monthlyId) {
        const price = await ensurePrice(
          stripe,
          product.id,
          plan.monthlyUsd,
          "month",
          `axis_manager_${plan.productKey.replace("axis_", "")}_monthly`,
        );
        monthlyId = price.id;
        console.log(`  + created ${plan.envMonthly}: ${monthlyId}`);
      }
      if (!annualId) {
        const price = await ensurePrice(
          stripe,
          product.id,
          plan.annualUsd,
          "year",
          `axis_manager_${plan.productKey.replace("axis_", "")}_annual`,
        );
        annualId = price.id;
        console.log(`  + created ${plan.envAnnual}: ${annualId}`);
      }
    }

    envOut[plan.envMonthly] = monthlyId;
    envOut[plan.envAnnual] = annualId;

    const tierSlug = plan.productKey.replace("axis_", "");
    if (monthlyId) {
      await ensureLookupKey(stripe, monthlyId, `axis_manager_${tierSlug}_monthly`, plan.envMonthly);
    }
    if (annualId) {
      await ensureLookupKey(stripe, annualId, `axis_manager_${tierSlug}_annual`, plan.envAnnual);
    }

    console.log("");
  }

  console.log("Add to .env.local:\n");
  for (const [k, v] of Object.entries(envOut)) {
    console.log(`${k}=${v}`);
  }

  if (WRITE_ENV) {
    const envPath = resolve(process.cwd(), ".env.local");
    const source = existsSync(envPath) ? envPath : resolve(process.cwd(), ".env");
    const base = existsSync(source) ? readFileSync(source, "utf8") : "";
    writeFileSync(envPath, upsertEnvLines(base, envOut), "utf8");
    console.log(`\nWrote price IDs to ${envPath}`);
  } else {
    console.log("\nRun with --write-env to append/update .env.local automatically.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
