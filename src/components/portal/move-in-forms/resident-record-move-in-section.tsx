"use client";

/**
 * Resident record › Move in (every resident stage). One section header card with the sub-tabs, in
 * the same order and words the resident sees in My home: Placement · Move-in details · Roommates ·
 * Inspections, and one body per sub-tab. (Forms is the record's own rail item, `forms-list.tsx`.)
 *  - Placement: the property, room and dates this resident is placed at.
 *  - Move-in details: what the resident received (instructions, photos, video) plus the house
 *    info, rules, Wi-Fi, instructions and amenities their own Move-in details tab shows.
 *  - Roommates: the other residents of the house, as the resident sees them — loaded from the
 *    server, which re-derives this manager's access to the record and redacts each peer by that
 *    peer's own sharing preferences.
 *  - Inspections: this resident's move-in / move-out inspections (`InspectionsPanel`).
 * Only facts that exist are shown; there is no "Opened" row because nothing records it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pencil, Plus } from "lucide-react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { ManagerResidentSectionToolbar } from "@/components/portal/manager-resident-section-toolbar";
import { InspectionsPanel } from "@/components/portal/inspections-panel";
import {
  AmenitiesSection,
  HousematesTabContent,
  InfoTabContent,
  InstructionsTabContent,
} from "@/components/portal/resident-move-in-view";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { Button } from "@/components/ui/button";
import { RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatLeaseDateLabel } from "@/lib/rental-application/lease-dates";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { resolveManagerListingSubmissionForPropertyId } from "@/lib/manager-property-save-target";
import {
  propertyDetailHref,
  RESIDENT_MOVE_IN_TABS,
  RESIDENT_MOVE_IN_TAB_LABELS,
  type ResidentMoveInTabId,
} from "@/lib/portal-detail-routes";
import {
  resolveResidentMoveInFromApplications,
  type ResidentMoveInHousemate,
} from "@/lib/resident-move-in-resolve";
import { sharedGet, type SharedGetResult } from "@/lib/shared-get-cache";

export type MoveInDetailsReceived = {
  instructions: string;
  photos: string;
  video: string;
};

const NONE = "None added";

/** What the property's existing move-in data gives this resident. Facts only; blanks say so. */
export function describeMoveInDetails(
  resolved: {
    instructions: string | null;
    houseInstructions: string | null;
    roomLabel: string;
    moveInPhotoDataUrls: string[];
    houseMoveInPhotoDataUrls: string[];
    moveInVideoDataUrl: string | null;
    houseMoveInVideoDataUrl: string | null;
    residentSection: { instructions: string | null; photoDataUrls: string[]; videoDataUrl: string | null } | null;
  } | null,
  entireHome: boolean,
): MoveInDetailsReceived {
  if (!resolved) return { instructions: NONE, photos: NONE, video: NONE };
  const scopes: string[] = [];
  if (resolved.houseInstructions) scopes.push("The whole house");
  if (resolved.instructions) {
    const room = resolved.roomLabel.trim();
    scopes.push(entireHome || !room || /not assigned/i.test(room) ? "The whole house" : room);
  }
  if (resolved.residentSection?.instructions) scopes.push("Their own space");
  const photoCount =
    resolved.moveInPhotoDataUrls.length +
    resolved.houseMoveInPhotoDataUrls.length +
    (resolved.residentSection?.photoDataUrls.length ?? 0);
  const hasVideo = Boolean(resolved.moveInVideoDataUrl || resolved.houseMoveInVideoDataUrl || resolved.residentSection?.videoDataUrl);
  return {
    instructions: scopes.length ? [...new Set(scopes)].join(" · ") : NONE,
    photos: photoCount ? String(photoCount) : NONE,
    video: hasVideo ? "Added" : NONE,
  };
}

function Card({ title, actions, children, dataAttr }: { title?: string; actions?: ReactNode; children: ReactNode; dataAttr: string }) {
  return (
    <section className="mb-4 flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm" data-attr={dataAttr}>
      {title ? (
        <div className="flex items-center gap-1 border-b border-border/70 px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function ResidentRecordMoveInSection({
  userId,
  applicationId,
  residentName,
  residentEmail,
  propertyId,
  basePath = "/portal",
  subTab,
  onSubTabChange,
  placement,
}: {
  userId: string;
  /** The application id the Residents routes use for this person. */
  applicationId: string;
  residentName: string;
  residentEmail: string;
  propertyId: string;
  basePath?: string;
  /** The open sub-tab (the record keeps it in the URL). Omitted = the section keeps it itself, opening on Placement. */
  subTab?: ResidentMoveInTabId;
  onSubTabChange?: (tab: ResidentMoveInTabId) => void;
  /** Where this resident is placed, for the Placement sub-tab. */
  placement?: { propertyLabel?: string; roomLabel?: string; moveInDate?: string; moveOutDate?: string };
}) {
  const [localTab, setLocalTab] = useState<ResidentMoveInTabId>("placement");
  // The Inspections sub-tab's blue + is the manager's one way to start an inspection: the embedded
  // `InspectionsPanel` owns the create flow, and bumping this counter is how the band asks for one.
  const [addInspectionRequest, setAddInspectionRequest] = useState(0);
  const activeTab = subTab ?? localTab;
  const changeTab = onSubTabChange ?? setLocalTab;
  const navigate = usePortalNavigate();
  const demo = isDemoModeActive();
  const first = residentName.trim().split(/\s+/)[0] || "this resident";

  // What this resident's own Move-in tabs would resolve to: the property's move-in copy and house
  // info. Resolved from THIS record's own application row — passing every row for the email let
  // the resolver pick an approved tenancy at another property and describe that one instead.
  const { resolved, entireHome } = useMemo(() => {
    const hit = propertyId ? resolveManagerListingSubmissionForPropertyId(userId, propertyId) : null;
    const row: DemoApplicantRow | undefined = readManagerApplicationRows().find((r) => r.id === applicationId);
    const property = hit
      ? ({ id: propertyId, title: "", buildingName: "", listingSubmission: hit.sub } as unknown as MockProperty)
      : undefined;
    const found =
      row && residentEmail && property
        ? resolveResidentMoveInFromApplications(residentEmail, [row], { [propertyId]: property })
        : null;
    return { resolved: found, entireHome: hit ? isEntireHomeListing(hit.sub) : false };
  }, [userId, applicationId, propertyId, residentEmail]);

  // Roommates come from the server: the household is the manager's whole set of current residents
  // at this property, which the browser's own copy of the application rows cannot be trusted to
  // scope or redact. The read is issued only when the Roommates sub-tab is open — it costs the
  // server a paged sweep of the manager's application rows — and is stamped with the record it
  // answered for, so moving to another resident never shows the previous one's household. A failed
  // read stays `failed`, never an empty list: "we could not look" is not "nobody lives here".
  const [loadedHousemates, setLoadedHousemates] = useState<
    { applicationId: string; list: ResidentMoveInHousemate[] } | { applicationId: string; failed: true } | null
  >(null);
  const householdRead = loadedHousemates?.applicationId === applicationId ? loadedHousemates : null;
  // Which record is on screen RIGHT NOW, read when a request settles rather than when it started.
  // A read can take up to the shared-GET timeout, and storing its answer against the record that
  // has since been replaced left the stamp above matching nothing: the open record then read as
  // still loading, with no retry on screen and no dependency left to change and re-read it.
  const viewedApplicationIdRef = useRef(applicationId);
  useEffect(() => {
    viewedApplicationIdRef.current = applicationId;
  }, [applicationId]);
  const storeHousehold = useCallback((requestedFor: string, result: SharedGetResult) => {
    if (viewedApplicationIdRef.current !== requestedFor) return;
    if (!result.ok) {
      setLoadedHousemates({ applicationId: requestedFor, failed: true });
      return;
    }
    const list = (result.data as { housemates?: unknown } | null)?.housemates;
    setLoadedHousemates({
      applicationId: requestedFor,
      list: Array.isArray(list) ? (list as ResidentMoveInHousemate[]) : [],
    });
  }, []);
  const householdHref =
    applicationId && !demo ? `/api/manager-applications/${encodeURIComponent(applicationId)}/housemates` : null;
  useEffect(() => {
    if (activeTab !== "housemates" || !householdHref) return;
    const requestedFor = applicationId;
    let cancelled = false;
    void sharedGet(householdHref).then((result) => {
      if (cancelled) return;
      storeHousehold(requestedFor, result);
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab, householdHref, applicationId, storeHousehold]);
  // Only the retry forces past the shared-GET cache, and it returns its own promise so the Button
  // owns the spinner for however long the forced read takes.
  const retryHousehold = useCallback(async () => {
    if (!householdHref) return;
    const requestedFor = applicationId;
    storeHousehold(requestedFor, await sharedGet(householdHref, { force: true }));
  }, [householdHref, applicationId, storeHousehold]);
  const details = useMemo(() => describeMoveInDetails(resolved, entireHome), [resolved, entireHome]);

  const tabItems = RESIDENT_MOVE_IN_TABS.map((id) => ({
    id,
    label: id === "placement" ? "Placement" : RESIDENT_MOVE_IN_TAB_LABELS[id],
    dataAttr: `resident-move-in-tab-${id}`,
  }));
  const openPropertyMoveIn = () => navigate(propertyDetailHref(basePath, "all", propertyId, "move-in"));
  const headerExtras =
    activeTab === "info" && propertyId ? (
      <PortalIconAction
        icon={Pencil}
        label="Edit move-in details"
        data-attr="resident-move-in-open-property"
        onClick={openPropertyMoveIn}
      />
    ) : null;
  const placementProperty = resolved?.propertyLabel?.trim() || placement?.propertyLabel?.trim() || "";
  const placementRoom = resolved?.roomLabel?.trim() || placement?.roomLabel?.trim() || "";
  const placementMoveIn = resolved?.earliestMoveInDateLabel?.trim() || placement?.moveInDate?.trim() || "";

  return (
    <div className="min-w-0" data-attr="resident-record-move-in" data-move-in-tab={activeTab}>
      <ManagerResidentSectionToolbar
        actions={
          activeTab === "inspections"
            ? [{ id: "add-inspection", label: "Add inspection", icon: Plus, tone: "primary" as const }]
            : []
        }
        onAction={(actionId) => {
          if (actionId === "add-inspection") setAddInspectionRequest((n) => n + 1);
        }}
        overflowMenu={headerExtras}
        destinationRow={
          <LocalDestinationNav
            items={tabItems}
            activeId={activeTab}
            onChange={(id) => changeTab(id as ResidentMoveInTabId)}
            ariaLabel="Move in sections"
            appearance="command"
            className="w-full"
          />
        }
      />

      {activeTab === "placement" ? (
        <Card dataAttr="resident-record-move-in-placement">
          <RecordFactRow label="Property" value={placementProperty || "Not set yet"} />
          {resolved?.addressLine ? <RecordFactRow label="Address" value={resolved.addressLine} /> : null}
          <RecordFactRow label="Room" value={placementRoom || "Not assigned yet"} />
          <RecordFactRow label="Move-in date" value={placementMoveIn || "Not set yet"} />
          {placement?.moveOutDate?.trim() ? <RecordFactRow label="Move-out date" value={formatLeaseDateLabel(placement.moveOutDate) || placement.moveOutDate.trim()} /> : null}
        </Card>
      ) : null}

      {activeTab === "info" ? (
        <>
          <Card title={`Move-in details ${first} received`} dataAttr="resident-record-move-in-details">
            <RecordFactRow label="Instructions" value={details.instructions} />
            <RecordFactRow label="Photos" value={details.photos} />
            <RecordFactRow label="Video" value={details.video} />
          </Card>
          {resolved ? (
            <div className="space-y-3" data-attr="resident-record-move-in-house-info">
              <InfoTabContent resolved={resolved} forManager />
              <InstructionsTabContent resolved={resolved} forManager />
              <AmenitiesSection resolved={resolved} forManager />
            </div>
          ) : null}
        </>
      ) : null}

      {activeTab === "housemates" ? (
        <div data-attr="resident-record-move-in-roommates">
          {demo || !applicationId ? (
            <PortalDataTableEmpty icon="residents" message="No other residents are listed for this household yet." />
          ) : householdRead === null ? (
            <PortalDataTableEmpty icon="residents" message="Loading this household…" />
          ) : "failed" in householdRead ? (
            <div
              role="alert"
              className="rounded-2xl border border-border bg-card p-6 text-center"
              data-attr="resident-move-in-roommates-error"
            >
              <p className="mb-3 text-sm">Couldn&apos;t load this household.</p>
              <Button variant="outline" onClick={() => retryHousehold()}>
                Try again
              </Button>
            </div>
          ) : (
            <HousematesTabContent
              housemates={householdRead.list}
              emptyMessage="No other residents are listed for this household yet."
            />
          )}
        </div>
      ) : null}

      {activeTab === "inspections" ? (
        <InspectionsPanel
          role="manager"
          applicationId={applicationId}
          embeddedInResident
          embeddedAddRequest={addInspectionRequest}
          embeddedToolbar={(nav) => (
            <div className="mb-2 rounded-xl border border-border bg-card px-1 shadow-sm" data-attr="resident-move-in-inspections-tabs">
              {nav}
            </div>
          )}
        />
      ) : null}

    </div>
  );
}
