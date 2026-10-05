"use client";

import { getNativeInfo } from "@/lib/native/push-client";
import {
  APPLE_IAP_OFFERED_PRODUCT_IDS,
  tierForAppleProductId,
} from "@/lib/manager-apple-purchase";
import type { PaidTier, StripeBilling } from "@/lib/stripe-price-ids";
import type { PurchasesPackage } from "@revenuecat/purchases-capacitor";

/**
 * Client-only RevenueCat (StoreKit) wrapper for the Capacitor iOS shell. Same
 * shape and safety as push-client.ts: every `@revenuecat/purchases-capacitor`
 * import is lazy, so nothing loads during SSR or in the web bundle until a
 * function actually runs inside the native app. On web every call is a no-op.
 *
 * The public Apple SDK key (`NEXT_PUBLIC_REVENUECAT_IOS_API_KEY`) is safe to
 * expose — it can only start purchases, never read revenue. Entitlement writes
 * happen server-side from the RevenueCat webhook; this layer just drives the
 * StoreKit sheet and hands the App User ID (our Supabase user id) to RevenueCat.
 */

/** RevenueCat's PURCHASE_CANCELLED_ERROR code (user dismissed the sheet). */
const PURCHASE_CANCELLED_CODE = "1";

let configuredForUser: string | null = null;
// Configuration, account switches, sign-out, and restore must observe one
// identity in order. Restore also checks the caller's live session before any
// queued provider work, so a queued restore for a signed-out user is discarded.
let identityOperation: Promise<void> = Promise.resolve();

function withIdentityLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = identityOperation.then(operation, operation);
  identityOperation = result.then(() => undefined, () => undefined);
  return result;
}

function iosApiKey(): string {
  return process.env.NEXT_PUBLIC_REVENUECAT_IOS_API_KEY?.trim() ?? "";
}

async function isIosNative(): Promise<boolean> {
  const { isNative, platform } = await getNativeInfo();
  return isNative && platform === "ios";
}

/**
 * Configures RevenueCat with the signed-in manager as the App User ID (so an
 * anonymous StoreKit purchase is tied to this account and can't leak across
 * users). Idempotent — re-logs-in if the user changed. No-op off-iOS or when the
 * key is unset. Safe to call on every app launch and before showing the paywall.
 */
async function configureForUser(appUserId: string): Promise<boolean> {
  const uid = appUserId.trim();
  const apiKey = iosApiKey();
  if (!uid || !apiKey) return false;
  if (!(await isIosNative())) return false;
  if (configuredForUser === uid) return true;

  try {
    const { Purchases } = await import("@revenuecat/purchases-capacitor");
    if (configuredForUser === null) {
      await Purchases.configure({ apiKey, appUserID: uid });
    } else {
      await Purchases.logIn({ appUserID: uid });
    }
    configuredForUser = uid;
    return true;
  } catch (err) {
    console.error("[revenuecat] configure failed", err);
    return false;
  }
}

export function configureRevenueCat(appUserId: string): Promise<boolean> {
  return withIdentityLock(() => configureForUser(appUserId));
}

/** Clears the RevenueCat identity on sign-out so the next user starts clean. */
export function logOutRevenueCat(): Promise<void> {
  return withIdentityLock(async () => {
    if (configuredForUser === null) return;
    try {
      const { Purchases } = await import("@revenuecat/purchases-capacitor");
      await Purchases.logOut();
    } catch {
      /* not configured / off-native — nothing to clear */
    } finally {
      configuredForUser = null;
    }
  });
}

export type ManagerOffering = {
  /** App Store product id. */
  productId: string;
  tier: PaidTier;
  billing: StripeBilling;
  /** Localized price incl. currency sign, from the store (e.g. "$20.00"). */
  priceString: string;
  title: string;
  /** The RevenueCat package to hand back to `purchaseManagerPackage`. */
  pkg: PurchasesPackage;
};

/**
 * The Pro/Business subscription packages available on this storefront, mapped to
 * our tiers with the store's localized price. Only our offered product ids are
 * returned (unknown/foreign packages are skipped). Empty off-iOS or when
 * offerings aren't configured yet.
 */
export async function getManagerOfferings(): Promise<ManagerOffering[]> {
  if (!(await isIosNative())) return [];
  const offered = new Set<string>(APPLE_IAP_OFFERED_PRODUCT_IDS);
  try {
    const { Purchases } = await import("@revenuecat/purchases-capacitor");
    const offerings = await Purchases.getOfferings();
    const packages = offerings.current?.availablePackages ?? [];
    const mapped: ManagerOffering[] = [];
    for (const pkg of packages) {
      const productId = pkg.product.identifier;
      const map = tierForAppleProductId(productId);
      if (!map || !offered.has(productId)) continue;
      mapped.push({
        productId,
        tier: map.tier,
        billing: map.billing,
        priceString: pkg.product.priceString,
        title: pkg.product.title,
        pkg,
      });
    }
    // Pro before Business; monthly before annual within each tier.
    mapped.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === "pro" ? -1 : 1;
      if (a.billing === b.billing) return 0;
      return a.billing === "monthly" ? -1 : 1;
    });
    return mapped;
  } catch (err) {
    console.error("[revenuecat] getOfferings failed", err);
    return [];
  }
}

export type PurchaseOutcome =
  | { status: "purchased" }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/**
 * Runs the StoreKit purchase sheet for a package. Server-side entitlement is
 * granted by the RevenueCat webhook, so callers should poll
 * `/api/manager/subscription` after a `purchased` result. Distinguishes a
 * user-cancelled sheet (no error UI) from a real failure.
 */
export async function purchaseManagerPackage(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  if (!(await isIosNative())) return { status: "error", message: "In-app purchase is only available in the iOS app." };
  try {
    const { Purchases } = await import("@revenuecat/purchases-capacitor");
    await Purchases.purchasePackage({ aPackage: pkg });
    return { status: "purchased" };
  } catch (err) {
    const e = err as { code?: string; userCancelled?: boolean | null; message?: string };
    if (e?.code === PURCHASE_CANCELLED_CODE || e?.userCancelled === true) {
      return { status: "cancelled" };
    }
    return { status: "error", message: e?.message ?? "Purchase failed." };
  }
}

/**
 * Restores previous purchases (required by App Review for reinstalls / new
 * devices). Returns whether RevenueCat now sees any active entitlement; the
 * server truth still comes from the webhook, so callers poll the subscription
 * route afterwards.
 */
export function restoreManagerPurchases(
  appUserId: string,
  isCurrentUser: () => boolean,
): Promise<{ ok: boolean; hasActiveEntitlement: boolean }> {
  return withIdentityLock(async () => {
    const uid = appUserId.trim();
    if (!uid || !isCurrentUser() || !(await configureForUser(uid)) || configuredForUser !== uid || !isCurrentUser()) {
      return { ok: false, hasActiveEntitlement: false };
    }
    try {
      const { Purchases } = await import("@revenuecat/purchases-capacitor");
      if (!isCurrentUser()) return { ok: false, hasActiveEntitlement: false };
      const customerInfo = await Purchases.restorePurchases();
      const active = customerInfo.customerInfo?.entitlements?.active ?? {};
      return { ok: true, hasActiveEntitlement: Object.keys(active).length > 0 };
    } catch (err) {
      console.error("[revenuecat] restore failed", err);
      return { ok: false, hasActiveEntitlement: false };
    }
  });
}
