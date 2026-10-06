import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import type { PortalTab } from "@/lib/portal-types";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import type { ResidentInspectionTypeFilter } from "@/lib/resident-inspections-tabs";
import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";
import { redactMoveInDetails } from "@/lib/resident-move-in-resolve";

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
  const resolved = loaded && formsLock ? redactMoveInDetails(loaded) : loaded;

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
      />
    </ManagerPortalPageShell>
  );
}
