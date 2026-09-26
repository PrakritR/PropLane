import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import type { PortalTab } from "@/lib/portal-types";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";

export async function ResidentMoveInPanel({
  residentEmail,
  basePath = RESIDENT_PORTAL_BASE_PATH,
  tabId = "placement",
  tabs: _tabs,
  focusRoomId,
  leaseSigned = false,
}: {
  residentEmail?: string | null;
  basePath?: string;
  tabId?: string;
  tabs?: PortalTab[];
  focusRoomId?: string;
  /** Already resolved by the caller's access check — free to pass along, no extra query. */
  leaseSigned?: boolean;
}) {
  const email = residentEmail?.trim().toLowerCase() || "";
  const resolved = email ? await loadResidentMoveInForEmail(email) : null;

  return (
    <ManagerPortalPageShell title="My home" hideTitleOnMobileNav compactFilterRow>
      <ResidentMoveInShell
        basePath={basePath}
        resolved={resolved}
        email={email}
        activeTab={tabId}
        focusRoomId={focusRoomId}
        leaseSigned={leaseSigned}
      />
    </ManagerPortalPageShell>
  );
}
