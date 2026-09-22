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

const AUTO_OPENED_KEY_PREFIX = "proplane:first-listing-wizard-auto-opened:";
const AUTO_OPEN_HANDOFF_KEY_PREFIX = "proplane:first-listing-wizard-auto-open-handoff:";

function sessionStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * "Already opened itself this session" — set the moment Properties decides to
 * auto-open, before any navigation. It is what keeps the wizard from opening a
 * SECOND time when the page remounts, and from opening again on a reload of a
 * still-empty portfolio within the same browser session. It deliberately lives
 * in sessionStorage, not localStorage: a manager who bounced off their first
 * visit is nudged again next session, until they close the wizard once
 * (`markFirstListingWizardDismissed`), which is the answer that sticks.
 */
export function readFirstListingWizardAutoOpened(userId: string | null | undefined): boolean {
  const id = userId?.trim();
  if (!id) return false;
  try {
    return sessionStore()?.getItem(AUTO_OPENED_KEY_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

export function markFirstListingWizardAutoOpened(userId: string | null | undefined): void {
  const id = userId?.trim();
  if (!id) return;
  try {
    sessionStore()?.setItem(AUTO_OPENED_KEY_PREFIX + id, "1");
  } catch {
    /* storage refused; the rule falls back to the listing count */
  }
}

/**
 * The auto-open intent, handed across a route change.
 *
 * Auto-opening happens on the page that also routes the manager from
 * `/properties/all` to `/properties/drafts`. `[stage]` is a dynamic segment,
 * so that push REMOUNTS the page and any wizard state opened on the old page
 * dies with it — which is how the wizard opened, closed, and opened again.
 * The page about to navigate writes the draft id here; the page that mounts
 * on Drafts takes it (once) and opens the wizard.
 */
export function writePendingFirstListingAutoOpen(userId: string | null | undefined, draftId: string): void {
  const id = userId?.trim();
  if (!id || !draftId.trim()) return;
  try {
    sessionStore()?.setItem(AUTO_OPEN_HANDOFF_KEY_PREFIX + id, draftId.trim());
  } catch {
    /* storage refused; the fresh page falls back to the rule below */
  }
}

/** Read AND clear the handoff — a second take returns null. */
export function takePendingFirstListingAutoOpen(userId: string | null | undefined): string | null {
  const id = userId?.trim();
  if (!id) return null;
  try {
    const store = sessionStore();
    const value = store?.getItem(AUTO_OPEN_HANDOFF_KEY_PREFIX + id)?.trim() || null;
    if (value) store?.removeItem(AUTO_OPEN_HANDOFF_KEY_PREFIX + id);
    return value;
  } catch {
    return null;
  }
}

/**
 * Properties never opens the create-listing wizard by itself.
 *
 * Kept as a named gate so leftover callers and tests fail closed. Visiting
 * Properties must stay on the requested stage (usually All) and leave the
 * wizard closed until the manager clicks Add.
 */
export function shouldAutoOpenFirstListingWizard(_opts: {
  snap: FirstListingPortfolioSnapshot;
  dismissed: boolean;
  coManagerLinksKnown?: boolean;
  autoOpenedThisSession?: boolean;
}): boolean {
  return false;
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
  incomingTeam?: boolean;
}): boolean {
  if (opts.demo ?? isDemoModeActive()) return true;
  if (isPortalSandboxEmail(opts.email)) return true;
  if (opts.incomingTeam) return true;
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
  opts?: {
    email?: string | null;
    portfolioSynced?: boolean;
    coManagerLinksKnown?: boolean;
    incomingTeam?: boolean;
    /**
     * Receives the server's explanation when the seed write is refused, so the
     * caller can tell the manager WHY the first-listing draft did not appear
     * instead of leaving it silently absent. A failed seed is still
     * recoverable — the manager can press Create — this only gives that dead
     * end a voice.
     */
    onError?: (message: string) => void;
  },
): Promise<{ draftId: string; created: boolean } | null> {
  const userId = managerUserId.trim();
  if (!userId) return null;
  if (shouldSkipFirstListingOnboarding({ email: opts?.email, incomingTeam: opts?.incomingTeam })) return null;

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
    onError: opts?.onError,
  });
  if (!draftId) return null;
  return { draftId, created: true };
}
