/**
 * Seeds the browser-local demo stores for the public `/demo` sandbox.
 *
 * Two modes (see `demo-guided.ts`):
 * - **idle** — the static snapshot (`buildDemoIdleSnapshot`, currently empty),
 *   optionally overlaid from the canonical test accounts via
 *   `/api/demo/portal-snapshot` when `DEMO_PORTAL_MIRROR_ENABLED` is on.
 * - **guided** — blank slate; autoplay creates data on top through the real
 *   wizards. Mirrors `testeverything@` instead when the mirror is enabled.
 *
 * Everything is written into each store's `seedDemo…` helper (never the server),
 * scoped to synthetic demo manager/resident ids. Real portal routes never call
 * these helpers — `isDemoModeActive()` gates every entry point.
 */
import { seedDemoHouseholdCharges } from "@/lib/household-charges";
import { seedDemoManagerApplicationRows } from "@/lib/manager-applications-storage";
import { seedDemoLeasePipeline } from "@/lib/lease-pipeline-storage";
import { seedDemoManagerWorkOrderRows } from "@/lib/manager-work-orders-storage";
import { seedDemoWorkOrderBids } from "@/lib/work-order-bids-storage";
import { seedDemoVendorPayouts } from "@/lib/vendor-payouts-storage";
import { seedDemoManagerVendorRows } from "@/lib/manager-vendors-storage";
import { seedDemoManagerPromotionRows } from "@/lib/manager-promotions-storage";
import { seedDemoManagerOutgoingExpenses } from "@/lib/manager-outgoing-payments";
import { seedDemoServiceRequests } from "@/lib/service-requests-storage";
import {
  seedDemoInbox,
  MANAGER_INBOX_STORAGE_KEY,
  RESIDENT_INBOX_STORAGE_KEY,
  VENDOR_INBOX_STORAGE_KEY,
} from "@/lib/portal-inbox-storage";
import { seedDemoManagerProperties } from "@/lib/demo-property-pipeline";
import { seedDemoBugFeedback } from "@/lib/portal-bug-feedback";
import { seedDemoAdminInbox } from "@/lib/demo-admin-partner-inbox";
import {
  managerPropertyAvailabilityStorageKey,
  seedDemoScheduleData,
} from "@/lib/demo-admin-scheduling";
import { seedDemoUploadedOwnLeases } from "@/lib/resident-lease-upload";
import {
  DEMO_RESIDENT_EMAIL,
  isDemoModeActive,
  resolveDemoPortfolioScopeUserId,
} from "@/lib/demo/demo-session";
import {
  getDemoGuidedState,
  hydrateDemoGuidedState,
  isGuidedDemoActive,
} from "@/lib/demo/demo-guided";
import { isDemoSignedIn } from "@/lib/demo/demo-client-teardown";
import { DEMO_PORTAL_MIRROR_ENABLED } from "@/lib/demo/demo-mirror-flag";
import {
  buildDemoBlankSnapshot,
  buildDemoGuidedSnapshot,
  buildDemoIdleSnapshot,
  buildHomeDemoSnapshot,
  type DemoDataSnapshot,
} from "@/lib/demo/demo-guided-data";
import { HOME_DEMO_EMBED_PATH } from "@/lib/demo/home-demo-embed";

/** The homepage Software demo's iframe seeds its own fixture world, never the mirror or the guided tour. */
function isHomeDemoEmbed(): boolean {
  return typeof window !== "undefined" && window.location?.pathname === HOME_DEMO_EMBED_PATH;
}

/** Put the homepage demo's world back to its first frame (used between chapters). */
export function seedHomeDemoData(): void {
  if (typeof window === "undefined" || !isDemoModeActive()) return;
  applyDemoSnapshot(buildHomeDemoSnapshot());
}

function applyDemoSnapshot(snapshot: DemoDataSnapshot): void {
  // The portfolio's scope never follows the role on screen: the homepage demo mounts in the resident's or the
  // vendor's portal and the manager's rows must still land under the manager.
  const managerScopeId = resolveDemoPortfolioScopeUserId();
  seedDemoManagerProperties(managerScopeId, snapshot.properties);
  seedDemoManagerApplicationRows(snapshot.applications, managerScopeId);
  seedDemoHouseholdCharges(snapshot.charges, snapshot.rentProfiles);
  seedDemoLeasePipeline(snapshot.leases, managerScopeId);

  const schedule = snapshot.schedule;
  seedDemoScheduleData({
    plannedEvents: schedule.plannedEvents,
    partnerInquiries: schedule.partnerInquiries,
    availabilityByStorageKey: Object.fromEntries(
      Object.entries(schedule.availabilityByPropertyId).map(([propertyId, slots]) => [
        managerPropertyAvailabilityStorageKey(managerScopeId, propertyId),
        slots,
      ]),
    ),
  });

  seedDemoUploadedOwnLeases(DEMO_RESIDENT_EMAIL, snapshot.residentUploads);
  seedDemoManagerWorkOrderRows(snapshot.workOrders);
  seedDemoWorkOrderBids(snapshot.workOrderBids);
  seedDemoVendorPayouts(snapshot.vendorPayouts);
  seedDemoManagerVendorRows(snapshot.vendors);
  seedDemoManagerPromotionRows(snapshot.promotions);
  seedDemoManagerOutgoingExpenses([]);
  seedDemoServiceRequests(snapshot.serviceRequests);
  seedDemoInbox(MANAGER_INBOX_STORAGE_KEY, snapshot.managerInbox);
  seedDemoInbox(RESIDENT_INBOX_STORAGE_KEY, snapshot.residentInbox);
  seedDemoInbox(VENDOR_INBOX_STORAGE_KEY, snapshot.vendorInbox);
  seedDemoAdminInbox(snapshot.adminInbox);
  seedDemoBugFeedback(snapshot.bugFeedback);
}

/** Resolve which snapshot to seed based on guided tour state. */
export function resolveDemoSnapshot(): DemoDataSnapshot {
  if (isHomeDemoEmbed()) return buildHomeDemoSnapshot();
  hydrateDemoGuidedState();
  const { mode, step } = getDemoGuidedState();
  if (mode === "guided" && step > 0) {
    return buildDemoGuidedSnapshot(step);
  }
  return buildDemoIdleSnapshot();
}

/**
 * Reset every demo store to idle or guided snapshot. Runs on each `/demo` mount
 * and whenever the guided step changes.
 */
export function seedDemoPortalData(): void {
  if (typeof window === "undefined" || !isDemoModeActive()) return;
  applyDemoSnapshot(resolveDemoSnapshot());
}

/** Re-seed after a guided step transition (same guards as `seedDemoPortalData`). */
export function reseedDemoPortalForGuidedStep(): void {
  if (typeof window === "undefined" || !isDemoModeActive() || !isGuidedDemoActive()) return;
  applyDemoSnapshot(buildDemoGuidedSnapshot(getDemoGuidedState().step));
}

/** Force the idle snapshot back on (exiting guided tour). */
export function seedDemoIdleData(): void {
  if (typeof window === "undefined" || !isDemoModeActive()) return;
  applyDemoSnapshot(buildDemoIdleSnapshot());
}

/** Clear every demo store for guided tour autoplay (blank slate). */
export function seedDemoBlankData(): void {
  if (typeof window === "undefined" || !isDemoModeActive()) return;
  applyDemoSnapshot(buildDemoBlankSnapshot());
}

/** Apply a partial snapshot (segment demos). */
export function applyDemoSnapshotForSegment(snapshot: DemoDataSnapshot): void {
  if (typeof window === "undefined" || !isDemoModeActive()) return;
  applyDemoSnapshot(snapshot);
}

/**
 * The homepage embeds the demo at `/`, which a signed-in manager also visits.
 * Seeding there would write demo rows into the shared portal-store sessionStorage
 * keys; navigating into the real portal (same tab) would then read — and mirror
 * back to the server — that demo residue. So the homepage embed never seeds for a
 * signed-in user. `/demo` is unaffected (it is a dedicated sandbox surface).
 */
function shouldSkipHomepageDemoSeed(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location?.pathname === "/" &&
    isDemoSignedIn()
  );
}

/**
 * Idle `/demo` mount: prefer the DB mirror when it is enabled and available,
 * else the static snapshot (`buildDemoIdleSnapshot`, currently empty).
 */
export async function seedDemoPortalIdleData(): Promise<void> {
  if (typeof window === "undefined" || !isDemoModeActive()) return;
  if (shouldSkipHomepageDemoSeed()) return;
  if (isHomeDemoEmbed()) {
    applyDemoSnapshot(buildHomeDemoSnapshot());
    return;
  }
  hydrateDemoGuidedState();
  const { mode, step } = getDemoGuidedState();
  if (mode === "guided" && step > 0) {
    applyDemoSnapshot(buildDemoGuidedSnapshot(step));
    return;
  }
  const mirrored = await seedDemoPortalDataFromMirror();
  if (!mirrored) {
    applyDemoSnapshot(buildDemoIdleSnapshot());
  }
}

/**
 * Guided tour base: mirror `testeverything@`'s real portal data (edits made
 * signed-in appear in the "Run demo" video); blank slate when the account is
 * absent or has no data. Never writes back — same one-way rule as idle.
 */
export async function seedDemoGuidedBaseData(): Promise<void> {
  if (typeof window === "undefined" || !isDemoModeActive()) return;
  if (!DEMO_PORTAL_MIRROR_ENABLED) {
    applyDemoSnapshot(buildDemoBlankSnapshot());
    return;
  }
  try {
    const res = await fetch("/api/demo/portal-snapshot?scope=guided", { credentials: "same-origin" });
    if (res.ok) {
      const body = (await res.json()) as { source?: string; snapshot?: DemoDataSnapshot };
      if (body.source === "mirror" && body.snapshot) {
        applyDemoSnapshot(body.snapshot);
        return;
      }
    }
  } catch {
    /* fall through to blank */
  }
  applyDemoSnapshot(buildDemoBlankSnapshot());
}

// TTL + in-flight guard (same pattern as the portal sync loaders): the landing
// page mounts the demo frame on every visit, so remounts within the TTL reuse
// the last mirror snapshot instead of re-hitting Supabase through the API.
const DEMO_SNAPSHOT_TTL_MS = 60_000;
let idleSnapshotCache: { at: number; snapshot: DemoDataSnapshot } | null = null;
let idleSnapshotPromise: Promise<DemoDataSnapshot | null> | null = null;

async function fetchIdleMirrorSnapshot(): Promise<DemoDataSnapshot | null> {
  if (idleSnapshotCache && Date.now() - idleSnapshotCache.at < DEMO_SNAPSHOT_TTL_MS) {
    return idleSnapshotCache.snapshot;
  }
  if (idleSnapshotPromise) return idleSnapshotPromise;
  idleSnapshotPromise = (async () => {
    try {
      const res = await fetch("/api/demo/portal-snapshot", { credentials: "same-origin" });
      if (!res.ok) return null;
      const body = (await res.json()) as { source?: string; snapshot?: DemoDataSnapshot };
      if (body.source !== "mirror" || !body.snapshot) return null;
      idleSnapshotCache = { at: Date.now(), snapshot: body.snapshot };
      return body.snapshot;
    } catch {
      return null;
    } finally {
      idleSnapshotPromise = null;
    }
  })();
  return idleSnapshotPromise;
}

/**
 * Overlay a read-only mirror from the canonical test accounts (production → demo).
 * Falls back silently — use `seedDemoPortalIdleData` for mirror-first idle seeding.
 */
export async function seedDemoPortalDataFromMirror(): Promise<boolean> {
  if (typeof window === "undefined" || !isDemoModeActive()) return false;
  if (!DEMO_PORTAL_MIRROR_ENABLED) return false;
  if (shouldSkipHomepageDemoSeed() || isHomeDemoEmbed()) return false;
  hydrateDemoGuidedState();
  if (isGuidedDemoActive()) return false;
  const snapshot = await fetchIdleMirrorSnapshot();
  if (!snapshot) return false;
  applyDemoSnapshot(snapshot);
  return true;
}
