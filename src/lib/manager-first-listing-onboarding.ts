/**
 * First-listing onboarding (PRP-396): seed one draft for an empty owner portfolio
 * and keep soft CTAs until a listing slot exists.
 *
 * Drafts never consume plan slots (`LISTING_SLOT_PROPERTY_STATUSES`); publishing
 * still goes through the normal quota gate.
 */

import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  adminKpiCounts,
  readAdminPropertyRows,
  saveManagerPropertyDraftToServer,
} from "@/lib/demo-admin-property-inventory";
import { countManagerManagedPropertiesForUser } from "@/lib/demo-property-pipeline";
import { createNewListingWizardSubmission } from "@/lib/manager-listing-submission";
import { collectLinkedPropertyIds } from "@/lib/manager-portfolio-access";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";

export type FirstListingPortfolioSnapshot = {
  /**
   * What the Properties page's own "Listed" tab shows.
   *
   * Read from the same counter the tab renders, so the seed can never disagree
   * with what the manager is looking at. `listingSlots` is a plan-slot count
   * over rows this account owns; a co-manager working somebody else's
   * portfolio has a Listed tab full of properties and an owned count of zero.
   */
  listed: number;
  listingSlots: number;
  drafts: number;
  unlisted: number;
  /**
   * Properties this account CO-MANAGES rather than owns.
   *
   * A co-manager working somebody else's portfolio has listings — they are just
   * not on their own row. Counting only owned rows read them as a brand-new
   * manager and pushed the first-listing wizard at someone who has been working
   * in the product for months.
   */
  coManaged: number;
};

export function readFirstListingPortfolioSnapshot(
  managerUserId: string | null | undefined,
): FirstListingPortfolioSnapshot {
  const id = managerUserId?.trim() || null;
  if (!id) return { listed: 0, listingSlots: 0, drafts: 0, unlisted: 0, coManaged: 0 };
  const kpi = adminKpiCounts(id);
  return {
    // Index 2 is the Listed bucket, the same one the tab counts.
    listed: kpi[2],
    listingSlots: countManagerManagedPropertiesForUser(id),
    drafts: kpi[5],
    unlisted: kpi[3],
    coManaged: collectLinkedPropertyIds(id).size,
  };
}

/**
 * Has this account got ANY property, by any route — owned, unlisted, or
 * co-managed? A draft is deliberately not one: a draft is an unfinished
 * listing, not a listing.
 */
export function managerHasAnyListing(snap: FirstListingPortfolioSnapshot): boolean {
  return snap.listed > 0 || snap.listingSlots > 0 || snap.unlisted > 0 || snap.coManaged > 0;
}

const DISMISSED_KEY_PREFIX = "proplane:first-listing-wizard-dismissed:";

export function firstListingWizardDismissedStorageKey(userId: string): string {
  return `${DISMISSED_KEY_PREFIX}${userId.trim()}`;
}

/** Has this manager already closed the first-listing wizard once? */
export function readFirstListingWizardDismissed(userId: string | null | undefined): boolean {
  const id = userId?.trim();
  if (!id || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(firstListingWizardDismissedStorageKey(id)) === "1";
  } catch {
    // A browser that refuses storage must not become a browser that reopens the
    // wizard forever, but it also cannot remember — treat it as not dismissed
    // and let the listing count do the work.
    return false;
  }
}

export function markFirstListingWizardDismissed(userId: string | null | undefined): void {
  const id = userId?.trim();
  if (!id || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(firstListingWizardDismissedStorageKey(id), "1");
  } catch {
    /* storage refused; the wizard simply may open again on this device */
  }
}

/**
 * Should Properties open the create-listing wizard by itself?
 *
 * Exactly two conditions, and both must hold:
 *
 * 1. The account has NO listing of any kind — nothing owned, nothing unlisted,
 *    and nothing co-managed. A leftover draft does not count, because a draft
 *    is what the wizard makes.
 * 2. The manager has never closed it. Closing it once is an answer, and the
 *    old rule ("keep opening until a listing exists") re-asked the question on
 *    every single visit to Properties.
 */
export function shouldAutoOpenFirstListingWizard(opts: {
  snap: FirstListingPortfolioSnapshot;
  dismissed: boolean;
  coManagerLinksKnown?: boolean;
}): boolean {
  if (opts.dismissed) return false;
  if (opts.coManagerLinksKnown === false) return false;
  return !managerHasAnyListing(opts.snap);
}

/** Empty owned portfolio — safe to mint the first seed draft. */
export function managerPortfolioNeedsFirstListingSeed(
  snap: FirstListingPortfolioSnapshot,
): boolean {
  return (
    snap.listed === 0 &&
    snap.listingSlots === 0 &&
    snap.drafts === 0 &&
    snap.unlisted === 0 &&
    snap.coManaged === 0
  );
}

/**
 * Soft onboarding: no listing slot yet, but a draft exists (or will). Unlisted
 * rows mean they already published once — do not trap them in first-listing UX.
 */
export function managerNeedsFirstListingOnboarding(
  snap: FirstListingPortfolioSnapshot,
): boolean {
  return (
    snap.listed === 0 &&
    snap.listingSlots === 0 &&
    snap.unlisted === 0 &&
    snap.coManaged === 0 &&
    snap.drafts > 0
  );
}

export function shouldSkipFirstListingOnboarding(opts: {
  demo?: boolean;
  email?: string | null;
}): boolean {
  if (opts.demo ?? isDemoModeActive()) return true;
  if (isPortalSandboxEmail(opts.email)) return true;
  return false;
}

const REDIRECT_KEY_PREFIX = "proplane:first-listing-dashboard-redirect:";

export function firstListingDashboardRedirectStorageKey(userId: string): string {
  return `${REDIRECT_KEY_PREFIX}${userId.trim()}`;
}

/**
 * Idempotent seed: when the portfolio is CONFIRMED empty, create one provisional
 * draft via the normal client save path. Returns the draft id and whether this
 * call minted it (so callers can open the wizard only on first seed).
 *
 * `portfolioSynced` is the caller's report from `syncManagerPortfolioFromServer`
 * and is REQUIRED to be true before anything is minted. The snapshot below reads
 * the local store, which is also empty when the sync never landed — offline, a
 * recompiling dev server, a 500, or simply a page opened before the first fetch
 * resolved. Trusting it unconditionally made "I could not load your properties"
 * indistinguishable from "you have none", and seeded a phantom
 * "Property · New listing" draft on established portfolios, which then dragged
 * the Properties tab onto Drafts (PRP-429). Failing to seed a genuinely new
 * account is recoverable — the manager clicks ADD PROPERTY — while inventing a
 * draft on an account with real listings is not.
 */
export async function ensureManagerFirstListingDraft(
  managerUserId: string,
  opts?: { email?: string | null; portfolioSynced?: boolean; coManagerLinksKnown?: boolean },
): Promise<{ draftId: string; created: boolean } | null> {
  const userId = managerUserId.trim();
  if (!userId) return null;
  if (shouldSkipFirstListingOnboarding({ email: opts?.email })) return null;

  const existing = readAdminPropertyRows(5, userId);
  if (existing.length > 0) {
    const draftId = existing[0]?.adminRefId?.trim() || "";
    return draftId ? { draftId, created: false } : null;
  }

  if (opts?.portfolioSynced !== true) return null;
  /*
    A confirmed PROPERTY sync says nothing about co-manager links, and the link
    cache reads empty both before it loads and when there are none. Seeding on
    that gave a co-manager with three properties on somebody else's portfolio a
    draft they never asked for, every visit. Not knowing is a refusal.
  */
  if (opts?.coManagerLinksKnown === false) return null;

  const snap = readFirstListingPortfolioSnapshot(userId);
  if (!managerPortfolioNeedsFirstListingSeed(snap)) return null;

  const draftId = await saveManagerPropertyDraftToServer(createNewListingWizardSubmission(), userId, {
    stepIndex: 0,
    maxStepReached: 0,
  });
  if (!draftId) return null;
  return { draftId, created: true };
}
