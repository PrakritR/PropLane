"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, Circle } from "lucide-react";
import { ResidentHousemateSharing } from "@/components/portal/resident-housemate-sharing";
import { ResidentMoveInForms } from "@/components/portal/move-in-forms/resident-move-in-forms";
import { ResidentMoveInMediaGallery } from "@/components/portal/move-in-media-fields";
import { HouseInfoReadSections, ResidentPortalHelpCard } from "@/components/portal/house-info-sections";
import { houseInfoIsEmpty } from "@/lib/house-info";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  isPendingUpfrontMoveInCharge,
  isUnpaidHouseholdCharge,
  readHouseholdCharges,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import { loadInspectionList } from "@/lib/inspections/client";
import { InspectionsPanel, pickPrimaryInspectionReport } from "@/components/portal/inspections-panel";
import type { ResidentInspectionTypeFilter } from "@/lib/resident-inspections-tabs";
import { cn } from "@/lib/utils";
import type { ResidentMoveInResolved, ResidentMoveInHousemate } from "@/lib/resident-move-in-resolve";
import {
  RESIDENT_MOVE_IN_TAB_LABELS,
  RESIDENT_MOVE_IN_TABS,
  residentMoveInHref,
  residentMoveInInspectionsHref,
  parseResidentMoveInTab,
  type ResidentMoveInTabId,
} from "@/lib/portal-detail-routes";

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value?.trim()) return null;
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}

/** Tri-state: `null` means still checking, so a row never flashes "Not yet" before the real answer lands. */
type MoveInChecklistStatus = boolean | null;

/**
 * C130 — every fact this checklist needs (lease, charges, inspection) already exists on other
 * tabs/pages; this just reads each one's own client source once, the same way that source's own
 * page does, rather than inventing a fourth "move-in status" table.
 */
function useMoveInChecklist(basePath: string): { chargesSettled: MoveInChecklistStatus; inspectionDone: MoveInChecklistStatus } {
  const { userId, ready } = usePortalSession();
  const [chargesSettled, setChargesSettled] = useState<MoveInChecklistStatus>(null);
  const [inspectionDone, setInspectionDone] = useState<MoveInChecklistStatus>(null);

  useEffect(() => {
    if (!ready) return;
    if (!userId || isDemoModeActive()) {
      // Demo/no-session mode never sends real requests; read as "nothing left to check".
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChargesSettled(true);
      setInspectionDone(true);
      return;
    }
    let cancelled = false;
    void syncHouseholdChargesFromServer().then(() => {
      if (cancelled) return;
      const moveInCharges = readHouseholdCharges().filter(isPendingUpfrontMoveInCharge);
      setChargesSettled(moveInCharges.every((charge) => !isUnpaidHouseholdCharge(charge)));
    }).catch(() => { if (!cancelled) setChargesSettled(false); });
    void loadInspectionList(userId, "resident").then((list) => {
      if (cancelled) return;
      const report = pickPrimaryInspectionReport(list.reports.filter((r) => r.kind === "move-in"));
      setInspectionDone(Boolean(report && report.photos.total > 0));
    }).catch(() => { if (!cancelled) setInspectionDone(false); });
    return () => { cancelled = true; };
  }, [ready, userId, basePath]);

  return { chargesSettled, inspectionDone };
}

function MoveInChecklistRow({ label, status, href }: { label: string; status: MoveInChecklistStatus; href: string }) {
  const Icon = status ? Check : Circle;
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 border-t border-border px-4 py-3.5 first:border-t-0 hover:bg-accent/40"
      data-attr="move-in-checklist-row"
    >
      <span className="flex items-center gap-2.5 text-sm text-foreground">
        <Icon className={cn("size-4 shrink-0", status ? "text-primary" : "text-muted/60")} strokeWidth={status ? 2.25 : 1.75} aria-hidden />
        {label}
      </span>
      <span className="text-[11px] font-bold uppercase tracking-[0.05em] text-muted">
        {status === null ? "Checking…" : status ? "Done" : "Not yet"}
      </span>
    </Link>
  );
}

/**
 * The default content of "Your placement" (C130): a resident used to check three separate tabs
 * (Lease, Payments, Inspections) to know whether move-in is actually done. Every fact here comes
 * from that same tab's own data source, so the checklist can never say something its own tab
 * would contradict.
 */
function MoveInChecklist({ basePath, leaseSigned }: { basePath: string; leaseSigned: boolean }) {
  const { chargesSettled, inspectionDone } = useMoveInChecklist(basePath);
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card" data-attr="move-in-checklist">
      <MoveInChecklistRow label="Lease signed" status={leaseSigned} href={`${basePath}/lease`} />
      <MoveInChecklistRow label="Move-in charges paid" status={chargesSettled} href={`${basePath}/payments`} />
      <MoveInChecklistRow label="Move-in inspection photographed" status={inspectionDone} href={residentMoveInInspectionsHref(basePath, "move-in")} />
    </div>
  );
}

function PlacementTabContent({ resolved, basePath, leaseSigned }: { resolved: ResidentMoveInResolved; basePath: string; leaseSigned: boolean }) {
  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <DetailField label="Assigned room" value={resolved.roomLabel} />
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Property</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{resolved.propertyLabel}</p>
          {resolved.addressLine ? <p className="mt-0.5 text-xs text-muted">{resolved.addressLine}</p> : null}
        </div>
        <DetailField label="Move-in date" value={resolved.earliestMoveInDateLabel ?? "Not set yet"} />
      </div>
      <div className="mt-6">
        <MoveInChecklist basePath={basePath} leaseSigned={leaseSigned} />
      </div>
    </div>
  );
}

function HousemateRow({ mate }: { mate: ResidentMoveInHousemate }) {
  return (
    <li className="ph-no-capture ph-no-record flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
      <div>
        <p className="text-sm font-semibold text-foreground">{mate.name}</p>
        <p className="mt-0.5 text-xs text-muted">{mate.roomLabel}</p>
      </div>
      <div className="text-right text-sm text-muted">
        {mate.phone ? (
          <a
            href={`tel:+1${mate.phone.replace(/\D/g, "").replace(/^1/, "")}`}
            className="font-medium text-foreground hover:text-primary"
          >
            {mate.phone}
          </a>
        ) : (
          <span>{mate.email ? "Phone not shared" : "Contact details not shared"}</span>
        )}
        {mate.email ? <p className="mt-0.5 text-xs">{mate.email}</p> : null}
      </div>
    </li>
  );
}

export function HousematesTabContent({
  resolved,
  emptyMessage = "No other residents are listed for your household yet.",
}: {
  resolved: ResidentMoveInResolved;
  /** The manager's resident record says this in its own voice. */
  emptyMessage?: string;
}) {
  if (resolved.housemates.length === 0) {
    return (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <PortalDataTableEmpty
          icon="residents"
          message={emptyMessage}
        />
      </div>
    );
  }

  // Sharing a room is a materially different relationship from sharing the house,
  // so it is called out rather than buried in one flat list. This is a NARROWING
  // of contact data the resident could already see — it grants nothing new, and
  // deliberately shows no roommate's rent, lease or documents.
  const roommates = resolved.housemates.filter((mate) => mate.isRoommate);
  const others = resolved.housemates.filter((mate) => !mate.isRoommate);

  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      {roommates.length > 0 ? (
        <section className="mb-6" data-attr="move-in-roommates">
          <h3 className="text-sm font-semibold text-foreground">Roommates — your room</h3>
          <ul className="divide-y divide-border/50">
            {roommates.map((mate, index) => (
              <HousemateRow key={mate.id ?? `housemate-${index}`} mate={mate} />
            ))}
          </ul>
        </section>
      ) : null}

      {others.length > 0 ? (
        <section data-attr="move-in-housemates">
          {roommates.length > 0 ? (
            <h3 className="text-sm font-semibold text-foreground">Housemates</h3>
          ) : null}
          <ul className={`divide-y divide-border/50 ${roommates.length > 0 ? "mt-3" : ""}`}>
            {others.map((mate, index) => (
              <HousemateRow key={mate.id ?? `housemate-${index}`} mate={mate} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function PageBody({ children }: { children: ReactNode }) {
  return <div className={PORTAL_LIST_PAGE_BODY}>{children}</div>;
}

function ManagerCardStack({ children }: { children: ReactNode }) {
  return <div className="min-w-0">{children}</div>;
}

/** A titled card on the manager's resident record: same chrome as the "received" card above it. */
function ManagerDetailCard({ title, dataAttr, children }: { title: string; dataAttr: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm" data-attr={dataAttr}>
      <div className="flex items-center border-b border-border/70 px-4 py-2.5">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
      </div>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function InfoTabContent({
  resolved,
  forManager = false,
}: {
  resolved: ResidentMoveInResolved;
  /** The manager's resident record: PropLane's "How your portal works" card is resident-facing, so it is left out. */
  forManager?: boolean;
}) {
  const hasSections = !houseInfoIsEmpty(resolved.houseInfo);
  const hasLegacyText = Boolean(resolved.generalHouseInfo || resolved.houseRulesText);
  // The manager's record stacks these as sibling cards, so the resident page-body padding stays out.
  const Body = forManager ? ManagerCardStack : PageBody;

  // "How your portal works" is PropLane's own copy, so it is worth showing even
  // to a resident whose manager has filled in nothing — it is the one thing on
  // this tab that is always true.
  if (!hasSections && !hasLegacyText) {
    return (
      <Body>
        <PortalDataTableEmpty
          icon="default"
          message={forManager ? "No house info or rules added yet." : "Your property manager has not added house info or rules yet."}
        />
        {forManager ? null : (
          <div className="mt-4">
            <ResidentPortalHelpCard />
          </div>
        )}
      </Body>
    );
  }

  return (
    <Body>
      <div className="space-y-3">
        <HouseInfoReadSections info={resolved.houseInfo} />

        {/* A property nobody has migrated still reads exactly as it did before. */}
        {hasLegacyText && forManager ? (
          <>
            {resolved.generalHouseInfo ? (
              <ManagerDetailCard title="House info" dataAttr="resident-move-in-general-info">
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{resolved.generalHouseInfo}</div>
              </ManagerDetailCard>
            ) : null}
            {resolved.houseRulesText ? (
              <ManagerDetailCard title="House rules" dataAttr="resident-move-in-house-rules">
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{resolved.houseRulesText}</div>
              </ManagerDetailCard>
            ) : null}
          </>
        ) : hasLegacyText ? (
          <section className="rounded-2xl border border-border bg-card px-4 py-3">
            <div className="space-y-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {resolved.generalHouseInfo ? <div>{resolved.generalHouseInfo}</div> : null}
              {resolved.houseRulesText ? <div>{resolved.houseRulesText}</div> : null}
            </div>
          </section>
        ) : null}

        {forManager ? null : <ResidentPortalHelpCard />}
      </div>
    </Body>
  );
}

/** Amenities read as a section of Move-in details; a home that lists none shows nothing here. */
export function AmenitiesSection({
  resolved,
  forManager = false,
}: {
  resolved: ResidentMoveInResolved;
  /** The manager's resident record draws this as a titled card. */
  forManager?: boolean;
}) {
  if (resolved.amenities.length === 0) return null;

  if (forManager) {
    return (
      <ManagerDetailCard title="Amenities" dataAttr="resident-move-in-amenities">
        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground">
          {resolved.amenities.map((amenity) => (
            <li key={amenity}>{amenity}</li>
          ))}
        </ul>
      </ManagerDetailCard>
    );
  }

  return (
    <div className={PORTAL_LIST_PAGE_BODY} data-attr="resident-move-in-amenities">
      <h3 className="mb-1.5 text-sm font-semibold text-foreground">Amenities</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground">
        {resolved.amenities.map((amenity) => (
          <li key={amenity}>{amenity}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Move-in details split into the two things they actually are: what applies to
 * the whole house, and what applies to the resident's own space.
 *
 * A room-by-room listing has both — the front door code is not the same fact as
 * which key opens Room 3 — and the house level used to be written by the manager
 * and read by nobody (AXI-163).
 */
export function InstructionsTabContent({
  resolved,
  focusRoomId,
  forManager = false,
}: {
  resolved: ResidentMoveInResolved;
  focusRoomId?: string;
  /** The manager's resident record draws each group as a titled card. */
  forManager?: boolean;
}) {
  // A room link (e.g. from a manager share) that names THIS resident's own
  // room skips the house section — it is asking to see the room, not the whole
  // house. A focusRoomId that does not match the viewer's own room is ignored
  // entirely: it never redacts or redirects to a room that is not theirs.
  const focused = Boolean(focusRoomId) && focusRoomId === resolved.roomId;
  const hasHouse =
    !focused &&
    (Boolean(resolved.houseInstructions) ||
      resolved.houseMoveInPhotoDataUrls.length > 0 ||
      Boolean(resolved.houseMoveInVideoDataUrl));

  if (forManager) {
    const room = resolved.instructions || resolved.moveInPhotoDataUrls.length > 0 || resolved.moveInVideoDataUrl;
    const mine = resolved.residentSection;
    return (
      <div className="space-y-3" data-attr="resident-move-in-arrival-cards">
        {hasHouse ? (
          <ManagerDetailCard title="Arrival: whole house" dataAttr="resident-move-in-house-section">
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{resolved.houseInstructions}</div>
            <ResidentMoveInMediaGallery
              photoDataUrls={resolved.houseMoveInPhotoDataUrls}
              videoDataUrl={resolved.houseMoveInVideoDataUrl}
            />
          </ManagerDetailCard>
        ) : null}
        {room ? (
          <ManagerDetailCard
            title={`Arrival: ${resolved.roomLabel.trim() || "room"}`}
            dataAttr="resident-move-in-room-section"
          >
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{resolved.instructions}</div>
            <ResidentMoveInMediaGallery
              photoDataUrls={resolved.moveInPhotoDataUrls}
              videoDataUrl={resolved.moveInVideoDataUrl}
            />
          </ManagerDetailCard>
        ) : null}
        {mine ? (
          <ManagerDetailCard title={`Arrival: Resident ${mine.slot}`} dataAttr="resident-move-in-resident-section">
            <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{mine.instructions}</div>
            <ResidentMoveInMediaGallery photoDataUrls={mine.photoDataUrls} videoDataUrl={mine.videoDataUrl} />
          </ManagerDetailCard>
        ) : null}
      </div>
    );
  }

  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      {hasHouse ? (
        <section className="mb-6" data-attr="resident-move-in-house-section">
          <h3 className="mb-1.5 text-sm font-semibold text-foreground">The whole house</h3>
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {resolved.houseInstructions}
          </div>
          <ResidentMoveInMediaGallery
            photoDataUrls={resolved.houseMoveInPhotoDataUrls}
            videoDataUrl={resolved.houseMoveInVideoDataUrl}
          />
        </section>
      ) : null}

      <section className="mb-6" data-attr="resident-move-in-room-section">
        {hasHouse ? (
          <h3 className="mb-1.5 text-sm font-semibold text-foreground">
            {resolved.roomLabel.trim() ? resolved.roomLabel : "Your room"}
          </h3>
        ) : null}
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {resolved.instructions ?? (
            <span className="text-muted">No room instructions have been added yet.</span>
          )}
        </div>
        <ResidentMoveInMediaGallery
          photoDataUrls={resolved.moveInPhotoDataUrls}
          videoDataUrl={resolved.moveInVideoDataUrl}
        />
      </section>

      {resolved.residentSection ? (
        <section data-attr="resident-move-in-resident-section">
          <h3 className="mb-1.5 text-sm font-semibold text-foreground">
            Your spot · Resident {resolved.residentSection.slot}
          </h3>
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {resolved.residentSection.instructions}
          </div>
          <ResidentMoveInMediaGallery
            photoDataUrls={resolved.residentSection.photoDataUrls}
            videoDataUrl={resolved.residentSection.videoDataUrl}
          />
        </section>
      ) : null}
    </div>
  );
}


function ResidentMoveInTabContent({
  activeTab,
  resolved,
  focusRoomId,
  basePath,
  leaseSigned,
}: {
  activeTab: ResidentMoveInTabId;
  resolved: ResidentMoveInResolved;
  focusRoomId?: string;
  basePath: string;
  leaseSigned: boolean;
}) {
  switch (activeTab) {
    case "forms":
      return <ResidentMoveInForms />;
    case "placement":
      return <PlacementTabContent resolved={resolved} basePath={basePath} leaseSigned={leaseSigned} />;
    case "housemates":
      return <><ResidentHousemateSharing /><HousematesTabContent resolved={resolved} /></>;
    case "info":
      // Arrival details live here now: keys, parking and access codes are house information,
      // and a "Move-in" tab beside "Inspections" read as a second inspection.
      return (
        <div className="space-y-6">
          <InfoTabContent resolved={resolved} />
          <InstructionsTabContent resolved={resolved} focusRoomId={focusRoomId} />
          <AmenitiesSection resolved={resolved} />
        </div>
      );
    default:
      return <PlacementTabContent resolved={resolved} basePath={basePath} leaseSigned={leaseSigned} />;
  }
}

/** My home — routed sections (forms, placement, move-in details, roommates, inspections). */
export function ResidentMoveInShell({
  basePath = "/resident",
  resolved,
  email,
  locked = false,
  activeTab = "placement",
  focusRoomId,
  leaseSigned = false,
  formsOnly = false,
  inspectionsTypeFilter,
}: {
  activeTab?: string;
  basePath?: string;
  resolved: ResidentMoveInResolved | null;
  email: string;
  locked?: boolean;
  /** Approved, lease not yet signed: Forms is the only tab, and nothing about the house is shown. */
  formsOnly?: boolean;
  /** A `room` search param naming a structured room id. Ignored unless it matches the viewer's OWN room. */
  focusRoomId?: string;
  /** Feeds the placement tab's move-in checklist (C130) — already resolved by the caller. */
  leaseSigned?: boolean;
  /** My home › Inspections list preselected to one type (`.../inspections/{move-in|move-out}`). */
  inspectionsTypeFilter?: ResidentInspectionTypeFilter;
}) {
  const tabId = parseResidentMoveInTab(activeTab);

  const destinations = useMemo(
    () =>
      RESIDENT_MOVE_IN_TABS.filter((id) => !formsOnly || id === "forms").map((id) => ({
        id,
        label: RESIDENT_MOVE_IN_TAB_LABELS[id],
        href: residentMoveInHref(basePath, id),
        dataAttr: `resident-move-in-tab-${id}`,
      })),
    [basePath, formsOnly],
  );

  useEffect(() => {
    document.documentElement.dataset.hideAssistantFab = "true";
    return () => {
      delete document.documentElement.dataset.hideAssistantFab;
    };
  }, []);

  return (
    <div className="text-sm leading-relaxed text-muted">
      {locked ? (
        <PortalDataTableEmpty message="Unlocks after both signatures are complete." icon="lease" />
      ) : !email ? (
        <PortalDataTableEmpty icon="default" message="Sign in to see your house details." />
      ) : formsOnly ? (
        <>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            stickyDestinations={false}
            destinations={destinations}
            activeDestinationId="forms"
            destinationAriaLabel="My home"
            destinationItemLayout="equal"
            destinationDenseEqualRow
          />
          <ResidentMoveInForms />
        </>
      ) : tabId === "inspections" ? (
        // Inspections load their own residencies and reports, so this tab needs no resolved
        // placement; the panel leads with the My home tab row (one control stack, like the
        // manager Move-in hub).
        <InspectionsPanel
          role="resident"
          routeBase={residentMoveInInspectionsHref(basePath)}
          residentTypeFilter={inspectionsTypeFilter}
          hubTabs={{ destinations, activeId: "inspections", ariaLabel: "My home" }}
        />
      ) : !resolved ? (
        <PortalDataTableEmpty icon="residents" message="No placement assigned yet." />
      ) : (
        <>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            stickyDestinations={false}
            destinations={destinations}
            activeDestinationId={tabId}
            destinationAriaLabel="My home"
            destinationItemLayout="equal"
            destinationDenseEqualRow
          />
          <ResidentMoveInTabContent activeTab={tabId} resolved={resolved} focusRoomId={focusRoomId} basePath={basePath} leaseSigned={leaseSigned} />
        </>
      )}
    </div>
  );
}

/** @deprecated Use {@link ResidentMoveInShell} — kept for imports during migration. */
export function ResidentMoveInResolvedView({
  resolved,
  basePath = "/resident",
  activeTab = "placement",
}: {
  resolved: ResidentMoveInResolved;
  activeTab?: string;
  basePath?: string;
}) {
  return (
    <ResidentMoveInShell
      basePath={basePath}
      resolved={resolved}
      email="resident@placeholder.local"
      activeTab={activeTab}
    />
  );
}
