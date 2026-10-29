import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import type { PortalTab } from "@/lib/portal-types";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import type { ResidentInspectionTypeFilter } from "@/lib/resident-inspections-tabs";
import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";
import { redactMoveInDetails, maskUnrevealedCheckIn } from "@/lib/resident-move-in-resolve";
import type { CheckInGuide } from "@/lib/check-in-guide";
import { loadTenancyCheckInContext, tenancyCheckInGuide, tenancyReveal } from "@/lib/check-in.server";
import { loadResidentLeaseSignedStatus, loadResidentManagerAttestedTenancy } from "@/lib/resident-portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export async function ResidentMoveInPanel({
  residentEmail,
  basePath = RESIDENT_PORTAL_BASE_PATH,
  tabId = "placement",
  tabs: _tabs,
  focusRoomId,
  leaseSigned = false,
  formsLock,
  inspectionsTypeFilter,
}: {
  residentEmail?: string | null;
  basePath?: string;
  tabId?: string;
  tabs?: PortalTab[];
  focusRoomId?: string;
  /** Already resolved by the caller's access check — free to pass along, no extra query. */
  leaseSigned?: boolean;
  /**
   * A form that blocks "Move-in details" is unsubmitted: the details tab shows the lock instead of the
   * house, and no door code, Wi-Fi, rule or photo is loaded into the page for any tab.
   * `formId` is the form that unlocks it, when known.
   */
  formsLock?: { formId?: string | null; readFailed?: boolean };
  /** Inspections tab only: the list preselected to one type. */
  inspectionsTypeFilter?: ResidentInspectionTypeFilter;
}) {
  const email = residentEmail?.trim().toLowerCase() || "";
  // The inspections tab loads its own data, so it skips the (heavier) house projection.
  const loaded = email && tabId !== "inspections" ? await loadResidentMoveInForEmail(email) : null;
  let resolved = loaded && formsLock ? redactMoveInDetails(loaded) : loaded;

  // The check-in reveal (`checkInReveal`): codes, the Wi-Fi password and the manager's free-text
  // instructions reach the browser only from 24 hours before move-in, and only once the lease is signed.
  // Before that the page is built from the MASKED house (every tab, not just Check-in), and the guide
  // carries `null` where a code would be. The decision is made here, on the server.
  let checkIn: CheckInGuide | null = null;
  if (loaded && !formsLock) {
    const db = createSupabaseServiceRoleClient();
    const [context, leaseUnlocked] = await Promise.all([
      loadTenancyCheckInContext(db, email).catch(() => null),
      leaseSigned
        ? Promise.resolve(true)
        : Promise.all([loadResidentLeaseSignedStatus(email), loadResidentManagerAttestedTenancy(email)])
            .then(([signed, attested]) => signed || attested)
            .catch(() => false),
    ]);
    const reveal = tenancyReveal(context, leaseUnlocked);
    checkIn = tenancyCheckInGuide(loaded, context, reveal);
    resolved = reveal.revealed ? loaded : maskUnrevealedCheckIn(loaded);
  }

  return (
    <ManagerPortalPageShell title="My home" hideTitleOnMobileNav compactFilterRow>
      <ResidentMoveInShell
        basePath={basePath}
        resolved={resolved}
        email={email}
        activeTab={tabId}
        focusRoomId={focusRoomId}
        leaseSigned={leaseSigned}
        formsLock={formsLock}
        inspectionsTypeFilter={inspectionsTypeFilter}
        checkIn={checkIn}
      />
    </ManagerPortalPageShell>
  );
}
