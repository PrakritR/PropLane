"use client";

/**
 * Client-only wrapper for the native "rate this app" flow — same shape and
 * safety as `push-client.ts`: the review plugin is imported lazily, so nothing
 * from `@capawesome/capacitor-app-review` executes during SSR or lands in the
 * web bundle; every call swallows errors and reports `false` on the web.
 *
 * Two halves:
 *  - the per-device record (localStorage) that the pure rules in
 *    `app-review-eligibility.ts` decide on, plus a tiny in-memory event so the
 *    sheet component learns about a delight moment without prop drilling;
 *  - the plugin calls: Apple's own in-place star sheet (`requestReview`,
 *    Play In-App Review on Android) and the App Store page fallback.
 *
 * The App Store rating only ever comes from Apple's sheet. Our star pick is an
 * in-app survey and is never sent to Apple.
 */

import { IOS_APP_STORE_APP_ID } from "@/lib/ios-app-download";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import {
  APP_REVIEW_STORAGE_KEY,
  applyAnswer,
  applyAppLaunch,
  applyPromptShown,
  emptyAppReviewState,
  parseAppReviewState,
  type AppReviewMoment,
  type AppReviewState,
} from "@/lib/native/app-review-eligibility";

/** Fired on `window` when a delight moment happens; the sheet listens for it. */
export const APP_REVIEW_OFFER_EVENT = "proplane:app-review:offer";

export type AppReviewOfferDetail = { moment: AppReviewMoment };

/* ------------------------------------------------------------------ */
/* Per-device record                                                   */
/* ------------------------------------------------------------------ */

export function readAppReviewState(now = Date.now()): AppReviewState {
  if (typeof window === "undefined") return emptyAppReviewState(now);
  try {
    const raw = window.localStorage.getItem(APP_REVIEW_STORAGE_KEY);
    const parsed = raw ? parseAppReviewState(JSON.parse(raw)) : null;
    return parsed ?? emptyAppReviewState(now);
  } catch {
    return emptyAppReviewState(now);
  }
}

export function writeAppReviewState(state: AppReviewState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APP_REVIEW_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — the sheet simply stays conservative */
  }
}

/**
 * Count a launch or foreground resume. Called from `NativeBridge`, so it only
 * ever runs inside the native shell. Also seeds `firstOpenAt` on the very
 * first call, which starts the install-age clock.
 */
export function recordAppLaunch(now = Date.now()): void {
  if (!isNativeRuntimeSync()) return;
  writeAppReviewState(applyAppLaunch(readAppReviewState(now)));
}

/**
 * Something just went right. Web callers are a no-op; native callers wake the
 * mounted sheet, which decides on its own whether the device is eligible.
 */
export function recordDelightMoment(moment: AppReviewMoment): void {
  if (typeof window === "undefined" || !isNativeRuntimeSync()) return;
  try {
    window.dispatchEvent(new CustomEvent<AppReviewOfferDetail>(APP_REVIEW_OFFER_EVENT, { detail: { moment } }));
  } catch {
    /* never let a celebration break the thing being celebrated */
  }
}

export function markAppReviewPromptShown(now = Date.now()): void {
  writeAppReviewState(applyPromptShown(readAppReviewState(now), now));
}

export function markAppReviewAnswer(
  answer: { kind: "stars"; stars: number } | { kind: "later" },
  now = Date.now(),
): void {
  writeAppReviewState(applyAnswer(readAppReviewState(now), answer, now));
}

/* ------------------------------------------------------------------ */
/* Plugin calls                                                        */
/* ------------------------------------------------------------------ */

/** Whether this shell build carries the review plugin at all. */
export async function isAppReviewPluginAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !isNativeRuntimeSync()) return false;
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("AppReview");
  } catch {
    return false;
  }
}

/**
 * Ask the OS to show its own rating sheet in place. Resolves `true` when the
 * request was handed to the OS — Apple never says whether it actually drew
 * the sheet, so `true` means "asked", not "shown". `false` on the web or when
 * the plugin is missing.
 */
export async function requestNativeReview(): Promise<boolean> {
  if (!(await isAppReviewPluginAvailable())) return false;
  try {
    const { AppReview } = await import("@capawesome/capacitor-app-review");
    await AppReview.requestReview();
    return true;
  } catch {
    return false;
  }
}

/** Open the store listing itself — the fallback when the OS declines to show its sheet. */
export async function openNativeStoreListing(): Promise<boolean> {
  if (!(await isAppReviewPluginAvailable())) return false;
  try {
    const { AppReview } = await import("@capawesome/capacitor-app-review");
    await AppReview.openAppStore({ appId: IOS_APP_STORE_APP_ID });
    return true;
  } catch {
    return false;
  }
}
