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
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";

export type FirstListingPortfolioSnapshot = {
  listingSlots: number;
  drafts: number;
  unlisted: number;
};

export function readFirstListingPortfolioSnapshot(
  managerUserId: string | null | undefined,
): FirstListingPortfolioSnapshot {
  const id = managerUserId?.trim() || null;
  if (!id) return { listingSlots: 0, drafts: 0, unlisted: 0 };
  const kpi = adminKpiCounts(id);
  return {
    listingSlots: countManagerManagedPropertiesForUser(id),
    drafts: kpi[5],
    unlisted: kpi[3],
  };
}

/** Empty owned portfolio — safe to mint the first seed draft. */
export function managerPortfolioNeedsFirstListingSeed(
  snap: FirstListingPortfolioSnapshot,
): boolean {
  return snap.listingSlots === 0 && snap.drafts === 0 && snap.unlisted === 0;
}

/**
 * Soft onboarding: no listing slot yet, but a draft exists (or will). Unlisted
 * rows mean they already published once — do not trap them in first-listing UX.
 */
export function managerNeedsFirstListingOnboarding(
  snap: FirstListingPortfolioSnapshot,
): boolean {
  return snap.listingSlots === 0 && snap.unlisted === 0 && snap.drafts > 0;
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
 * Idempotent seed: when the local snapshot is empty, create one provisional
 * draft via the normal client save path. Returns the draft id and whether this
 * call minted it (so callers can open the wizard only on first seed).
 */
export async function ensureManagerFirstListingDraft(
  managerUserId: string,
  opts?: { email?: string | null },
): Promise<{ draftId: string; created: boolean } | null> {
  const userId = managerUserId.trim();
  if (!userId) return null;
  if (shouldSkipFirstListingOnboarding({ email: opts?.email })) return null;

  const existing = readAdminPropertyRows(5, userId);
  if (existing.length > 0) {
    const draftId = existing[0]?.adminRefId?.trim() || "";
    return draftId ? { draftId, created: false } : null;
  }

  const snap = readFirstListingPortfolioSnapshot(userId);
  if (!managerPortfolioNeedsFirstListingSeed(snap)) return null;

  const draftId = await saveManagerPropertyDraftToServer(createNewListingWizardSubmission(), userId, {
    stepIndex: 0,
    maxStepReached: 0,
  });
  if (!draftId) return null;
  return { draftId, created: true };
}
