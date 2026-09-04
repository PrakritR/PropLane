"use client";

import { useEffect, useMemo } from "react";
import { ResidentMoveInMediaGallery } from "@/components/portal/move-in-media-fields";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PORTAL_INLINE_UNLOCK_NOTICE_CLASS } from "@/components/portal/portal-metrics";
import type { ResidentMoveInResolved } from "@/lib/resident-move-in-resolve";
import {
  RESIDENT_MOVE_IN_TAB_LABELS,
  RESIDENT_MOVE_IN_TAB_SHORT_LABELS,
  RESIDENT_MOVE_IN_TABS,
  residentMoveInHref,
  parseResidentMoveInTab,
  type ResidentMoveInTabId,
} from "@/lib/portal-detail-routes";

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value?.trim()) return null;
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

function PlacementTabContent({ resolved }: { resolved: ResidentMoveInResolved }) {
  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      <p className="mb-4 text-sm text-muted">Where you are assigned and when you can move in.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <DetailField label="Assigned room" value={resolved.roomLabel} />
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Property</p>
          <p className="mt-1 text-sm font-medium text-foreground">{resolved.propertyLabel}</p>
          {resolved.addressLine ? <p className="mt-0.5 text-xs text-muted">{resolved.addressLine}</p> : null}
        </div>
        <DetailField label="Move-in date" value={resolved.earliestMoveInDateLabel ?? "Not set yet"} />
      </div>
    </div>
  );
}

function HousematesTabContent({ resolved }: { resolved: ResidentMoveInResolved }) {
  if (resolved.housemates.length === 0) {
    return (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <PortalDataTableEmpty
          icon="residents"
          message="No other residents are listed for your household yet."
        />
      </div>
    );
  }

  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      <p className="mb-4 text-sm text-muted">Other residents in your household.</p>
      <ul className="divide-y divide-border/50">
        {resolved.housemates.map((mate) => (
          <li
            key={mate.email}
            className="flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0"
          >
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
                <span>No phone on file</span>
              )}
              <p className="mt-0.5 text-xs">{mate.email}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InfoTabContent({ resolved }: { resolved: ResidentMoveInResolved }) {
  if (!resolved.generalHouseInfo && !resolved.houseRulesText) {
    return (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <PortalDataTableEmpty
          icon="default"
          message="Your property manager has not added house info or rules yet."
        />
      </div>
    );
  }

  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      <p className="mb-4 text-sm text-muted">Shared information from your property manager.</p>
      <div className="space-y-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {resolved.generalHouseInfo ? <div>{resolved.generalHouseInfo}</div> : null}
        {resolved.houseRulesText ? <div>{resolved.houseRulesText}</div> : null}
      </div>
    </div>
  );
}

function AmenitiesTabContent({ resolved }: { resolved: ResidentMoveInResolved }) {
  if (resolved.amenities.length === 0) {
    return (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <PortalDataTableEmpty icon="default" message="No amenities have been listed for this home yet." />
      </div>
    );
  }

  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      <p className="mb-4 text-sm text-muted">What this home offers.</p>
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
function InstructionsTabContent({ resolved }: { resolved: ResidentMoveInResolved }) {
  const hasHouse =
    Boolean(resolved.houseInstructions) ||
    resolved.houseMoveInPhotoDataUrls.length > 0 ||
    Boolean(resolved.houseMoveInVideoDataUrl);

  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      <p className="mb-4 text-sm text-muted">
        Keys, parking, access codes, and anything to know before arrival.
      </p>

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

      <section data-attr="resident-move-in-room-section">
        {hasHouse ? (
          <h3 className="mb-1.5 text-sm font-semibold text-foreground">
            {resolved.roomLabel.trim() ? resolved.roomLabel : "Your room"}
          </h3>
        ) : null}
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {resolved.instructions ?? (
            <span className="text-muted">
              No house instructions have been added for this room yet. Your property manager can add keys,
              parking, access codes, and house rules when they edit the listing.
            </span>
          )}
        </div>
        <ResidentMoveInMediaGallery
          photoDataUrls={resolved.moveInPhotoDataUrls}
          videoDataUrl={resolved.moveInVideoDataUrl}
        />
      </section>
    </div>
  );
}

function ResidentMoveInTabContent({
  activeTab,
  resolved,
}: {
  activeTab: ResidentMoveInTabId;
  resolved: ResidentMoveInResolved;
}) {
  switch (activeTab) {
    case "placement":
      return <PlacementTabContent resolved={resolved} />;
    case "housemates":
      return <HousematesTabContent resolved={resolved} />;
    case "info":
      return <InfoTabContent resolved={resolved} />;
    case "amenities":
      return <AmenitiesTabContent resolved={resolved} />;
    case "instructions":
      return <InstructionsTabContent resolved={resolved} />;
    default:
      return <PlacementTabContent resolved={resolved} />;
  }
}

/** House details — routed sub-tabs (placement, housemates, info, amenities, move-in). */
export function ResidentMoveInShell({
  basePath = "/resident",
  resolved,
  email,
  locked = false,
  activeTab = "placement",
}: {
  activeTab?: string;
  basePath?: string;
  resolved: ResidentMoveInResolved | null;
  email: string;
  locked?: boolean;
}) {
  const tabId = parseResidentMoveInTab(activeTab);

  const destinations = useMemo(
    () =>
      RESIDENT_MOVE_IN_TABS.map((id) => ({
        id,
        label: RESIDENT_MOVE_IN_TAB_LABELS[id],
        shortLabel: RESIDENT_MOVE_IN_TAB_SHORT_LABELS[id],
        href: residentMoveInHref(basePath, id),
        dataAttr: `resident-move-in-tab-${id}`,
      })),
    [basePath],
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
        <>
          <p className={PORTAL_INLINE_UNLOCK_NOTICE_CLASS}>
            <span className="font-semibold">Available once your lease is signed.</span> House details unlock after
            both you and your property manager have signed the lease.
          </p>
          <PortalDataTableEmpty message="Unlocks after both signatures are complete." icon="lease" />
        </>
      ) : !email ? (
        <p className={`${PORTAL_INLINE_UNLOCK_NOTICE_CLASS} portal-banner-pending`}>
          Sign in to see house details for your placement.
        </p>
      ) : !resolved ? (
        <PortalDataTableEmpty
          icon="residents"
          message="We could not find an approved placement tied to this account yet. Once your property manager assigns your listing room, your house details will appear here automatically."
        />
      ) : (
        <>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            stickyDestinations={false}
            destinations={destinations}
            activeDestinationId={tabId}
            destinationAriaLabel="House details"
            destinationItemLayout="equal"
            destinationDenseEqualRow
          />
          <ResidentMoveInTabContent activeTab={tabId} resolved={resolved} />
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
