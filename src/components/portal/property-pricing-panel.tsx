"use client";

import type { ServiceFeePayer } from "@/lib/payment-policy";

import { useCallback, useEffect, useMemo, useState } from "react";
import { activeWorkspaceIdentity } from "@/lib/workspaces/selection";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { PropertyPricingSettingsModal } from "@/components/portal/property-pricing-settings-modal";
import {
  PropertyRoomPricingWorkspace,
  type PropertyPricingSubject,
} from "@/components/portal/property-room-pricing-workspace";
import {
  emptyBundleRow,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { persistManagerListingSubmissionOnServer, type ManagerPricingSaveTarget } from "@/lib/manager-property-save-target";
import {
  propertyPricingBundleSummary,
  propertyPricingBundleTitle,
  propertyPricingRoomAmount,
  propertyPricingRoomDepositFact,
  propertyPricingRoomSummary,
  propertyPricingTermsFact,
  propertyPricingWholeHouseSummary,
} from "@/lib/property-pricing-summary";
import { resetRoomToWorkspaceDefault, resetWholeHouseToWorkspaceDefault } from "@/lib/property-pricing-publish";
import {
  normalizeWorkspacePricingDefaults,
  type WorkspacePricingDefaults,
} from "@/lib/workspace-pricing-defaults";
import type { RentRuleAddress } from "@/lib/seattle-rent-rule";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { House, Layers, MoreHorizontal, PanelsTopLeft, ScrollText, ShieldCheck, type LucideIcon } from "lucide-react";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { Settings } from "lucide-react";

type PricingTab = "rooms" | "bundles" | "whole";

type Props = {
  submission: ManagerListingSubmissionV1;
  saveTarget: ManagerPricingSaveTarget;
  managerUserId: string;
  propertyLabel: string;
  onUpdated: () => void;
  showToast: (message: string) => void;
  workspacePricingDefaults?: WorkspacePricingDefaults;
  /** The stored property record's address — see {@link PropertyRoomPricingWorkspace}. */
  listingProperty?: RentRuleAddress | null;
};

/** The square icon tile every pricing row carries: rooms, bundles and the whole house look alike. */
function PricingRowTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-14 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
      <Icon className="size-5" />
    </span>
  );
}

export function PropertyPricingPanel({
  submission,
  saveTarget,
  managerUserId,
  propertyLabel,
  onUpdated,
  showToast,
  workspacePricingDefaults: workspacePricingDefaultsProp,
  listingProperty = null,
}: Props) {
  const [workspacePricingDefaults, setWorkspacePricingDefaults] = useState<WorkspacePricingDefaults>(
    () => normalizeWorkspacePricingDefaults(workspacePricingDefaultsProp ?? {}),
  );
  const [workspacePayment, setWorkspacePayment] = useState<{ serviceFeePayer?: ServiceFeePayer | null } | null>(
    null,
  );

  const loadWorkspace = useCallback(async () => {
    const wsId = activeWorkspaceIdentity()?.id;
    if (!wsId) return;
    const res = await fetch(
      `/api/portal/manager-manual-payment-settings?workspaceId=${encodeURIComponent(wsId)}`,
      { cache: "no-store" },
    );
    const data = await res.json();
    const row = data.workspacePaymentSettings?.[wsId];
    if (row?.pricingDefaults) setWorkspacePricingDefaults(normalizeWorkspacePricingDefaults(row.pricingDefaults));
    if (row) setWorkspacePayment({ serviceFeePayer: row.serviceFeePayer });
  }, []);

  useEffect(() => {
    if (workspacePricingDefaultsProp && Object.keys(workspacePricingDefaultsProp).length > 0) {
      setWorkspacePricingDefaults(normalizeWorkspacePricingDefaults(workspacePricingDefaultsProp));
      return;
    }
    void loadWorkspace();
  }, [loadWorkspace, workspacePricingDefaultsProp]);

  const sub = useMemo(() => normalizeManagerListingSubmissionV1(submission), [submission]);
  const [tab, setTab] = useState<PricingTab>("rooms");
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [subject, setSubject] = useState<PropertyPricingSubject | null>(null);

  const rooms = sub.rooms.filter((r) => r.name.trim() || r.monthlyRent > 0);
  const bundles = sub.bundles ?? [];
  const entireHome = isEntireHomeListing(sub);

  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);

  const filteredRooms = rooms.filter((r) => match(r.name?.trim() || "room") || match(propertyPricingRoomSummary(r, sub, sub.roomPricingMeta?.[r.id])));
  const filteredBundles = bundles.filter((b) => match(b.label?.trim() || "bundle") || match(propertyPricingBundleSummary(b, sub)));
  const showWholeTab = !entireHome || sub.entireHomeOffered || (sub.entireHomeMonthlyRent ?? 0) > 0;

  // Server-confirmed: "Pricing saved" is only said once the record is stored, never on a background mirror that
  // can still be refused (a refused mirror put the old prices back on the next reload).
  const persist = async (next: ManagerListingSubmissionV1) => {
    const normalized = normalizeManagerListingSubmissionV1(next);
    if (!(await persistManagerListingSubmissionOnServer(saveTarget, managerUserId, normalized))) {
      showToast("Could not save pricing.");
      return false;
    }
    onUpdated();
    return true;
  };

  const openSubject = (s: PropertyPricingSubject) => {
    setSubject(s);
    setWorkspaceOpen(true);
  };

  const addForTab = async () => {
    if (tab === "bundles") {
      const next = emptyBundleRow();
      const draft = normalizeManagerListingSubmissionV1({ ...sub, bundles: [...bundles, next] });
      if (!(await persist(draft))) return;
      openSubject({ kind: "bundle", bundleId: next.id });
      return;
    }
    if (tab === "whole") {
      openSubject({ kind: "whole" });
      return;
    }
    const room = rooms[0];
    if (room) openSubject({ kind: "room", roomId: room.id });
    else showToast("Add a room on House details first.");
  };

  // Row fact: the lease types this property offers, in the one label set ("Long-term · Short-term").
  const leaseTermsLabel = propertyPricingTermsFact(sub);
  const wholeHouseSummary = propertyPricingWholeHouseSummary(sub);
  // The figure is the rent when there is one; a house that is not offered has no figure, so no stray dash.
  const wholeHouseAmount = wholeHouseSummary.includes("/mo") ? wholeHouseSummary.split(" · ").pop() : undefined;
  const addLabel =
    tab === "bundles" ? "Add bundle" : tab === "whole" ? "Add whole house price" : "Add room price";

  const tabItems = [
    { id: "rooms" as const, label: "Rooms", count: rooms.length },
    { id: "bundles" as const, label: "Room bundles", count: bundles.length },
    ...(showWholeTab
      ? [{ id: "whole" as const, label: "Whole house", count: sub.entireHomeOffered || entireHome ? 1 : 0 }]
      : []),
  ];

  const emptyCopy =
    tab === "bundles"
      ? "No bundles yet — group rooms that rent together for one price."
      : tab === "whole"
        ? "Whole house is not offered on this listing."
        : "No rooms to price yet.";

  return (
    <div className="ps40 space-y-2" data-ps40-page="payments" data-attr="property-pricing">
      <PortalListControlStack
        className="plp-header-card mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={
          <LocalDestinationNav
            items={tabItems.map((t) => ({
              id: t.id,
              label: t.label,
              count: t.count,
              dataAttr: `property-pricing-tab-${t.id}`,
            }))}
            activeId={tab}
            onChange={(id) => setTab(id as PricingTab)}
            ariaLabel="Pricing"
            appearance="command"
          />
        }
        activeDestinationId={tab}
        destinationAriaLabel="Pricing"
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search pricing",
          ariaLabel: "Search pricing",
          dataAttr: "property-pricing-search",
        }}
        actions={
          <PortalIconAction
            icon={Settings}
            label="Payment settings"
            data-attr="ps40-settings"
            onClick={() => setSettingsOpen(true)}
          />
        }
        primary={
          <PortalPrimaryIconAction label={addLabel} data-attr="property-pricing-add" onClick={addForTab} />
        }
      />

      <PortalRecordListSurface
        isEmpty={
          tab === "rooms"
            ? filteredRooms.length === 0
            : tab === "bundles"
              ? filteredBundles.length === 0
              : !showWholeTab
        }
        emptyCard={{ title: emptyCopy, section: "pricing" }}
      >
        {tab === "rooms"
          ? filteredRooms.map((room) => {
              const meta = sub.roomPricingMeta?.[room.id];
              const depositFact = propertyPricingRoomDepositFact(room, sub);
              const canReset =
                meta?.priceSource === "default" ||
                meta?.priceSource === "own" ||
                room.monthlyRent > 0;
              return (
                <PortalPropertyRecordRow
                  key={room.id}
                  title={room.name.trim() || "Room"}
                  amount={propertyPricingRoomAmount(room)}
                  onOpen={() => openSubject({ kind: "room", roomId: room.id })}
                  leading={<PricingRowTile icon={PanelsTopLeft} />}
                  leadingShape="square"
                  facts={
                    leaseTermsLabel || depositFact ? (
                      <>
                        {leaseTermsLabel ? <PortalRowFact icon={ScrollText} srLabel="Leases offered">{leaseTermsLabel}</PortalRowFact> : null}
                        {depositFact ? <PortalRowFact icon={ShieldCheck} srLabel="Deposit">{depositFact}</PortalRowFact> : null}
                      </>
                    ) : undefined
                  }
                  dataAttr="property-pricing-room-row"
                  actions={
                    <PricingRowMenu
                      label={room.name.trim() || "Room"}
                      onEdit={() => openSubject({ kind: "room", roomId: room.id })}
                      onReset={canReset ? () => {
                        const next = resetRoomToWorkspaceDefault(sub, room.id, workspacePricingDefaults);
                        if (!next) {
                          showToast("No workspace default for this room.");
                          return;
                        }
                        void persist(next).then((ok) => {
                          if (ok) showToast("Room reset to workspace default.");
                        });
                      } : undefined}
                    />
                  }
                />
              );
            })
          : null}

        {tab === "bundles"
          ? filteredBundles.map((bundle) => (
              <PortalPropertyRecordRow
                key={bundle.id}
                title={propertyPricingBundleTitle(bundle, sub)}
                leading={<PricingRowTile icon={Layers} />}
                leadingShape="square"
                amount={
                  bundle.price?.trim()
                    ? `${bundle.price.replace(/\/mo$/i, "").trim()}/mo`
                    : undefined
                }
                facts={
                  bundle.price?.trim() ? undefined : <PortalRowFact icon={ScrollText} srLabel="Price">No price</PortalRowFact>
                }
                onOpen={() => openSubject({ kind: "bundle", bundleId: bundle.id })}
                dataAttr="property-pricing-bundle-row"
                actions={<PricingRowMenu label={propertyPricingBundleTitle(bundle, sub)} onEdit={() => openSubject({ kind: "bundle", bundleId: bundle.id })} />}
              />
            ))
          : null}

        {tab === "whole" && showWholeTab ? (
          <PortalPropertyRecordRow
            title="Whole house"
            leading={<PricingRowTile icon={House} />}
            leadingShape="square"
            amount={wholeHouseAmount}
            facts={
              <PortalRowFact icon={ScrollText} srLabel={wholeHouseAmount ? "Leases offered" : "Whole house"}>
                {wholeHouseAmount && leaseTermsLabel ? leaseTermsLabel : wholeHouseSummary}
              </PortalRowFact>
            }
            onOpen={() => openSubject({ kind: "whole" })}
            dataAttr="property-pricing-whole-row"
            actions={
              <PricingRowMenu
                label="Whole house"
                onEdit={() => openSubject({ kind: "whole" })}
                onReset={sub.entireHomePriceSource === "default" || sub.entireHomePriceSource === "own" ? () => {
                  const next = resetWholeHouseToWorkspaceDefault(sub, workspacePricingDefaults);
                  if (!next) {
                    showToast("No workspace default for the whole house.");
                    return;
                  }
                  void persist(next).then((ok) => {
                    if (ok) showToast("Whole house reset to workspace default.");
                  });
                } : undefined}
              />
            }
          />
        ) : null}
      </PortalRecordListSurface>

      <PropertyPricingSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        sub={sub}
        saveTarget={saveTarget}
        managerUserId={managerUserId}
        propertyLabel={propertyLabel}
        onSaved={onUpdated}
        showToast={showToast}
        workspacePayment={workspacePayment}
      />

      {subject ? (
        <PropertyRoomPricingWorkspace
          open={workspaceOpen}
          onClose={() => {
            setWorkspaceOpen(false);
            setSubject(null);
          }}
          subject={subject}
          sub={sub}
          saveTarget={saveTarget}
          managerUserId={managerUserId}
          propertyLabel={propertyLabel}
          onSaved={onUpdated}
          showToast={showToast}
          workspacePricingDefaults={workspacePricingDefaults}
          listingProperty={listingProperty}
        />
      ) : null}
    </div>
  );
}

/** Every pricing row's ⋯: Edit pricing first, then Reset to default when the row can inherit. */
function PricingRowMenu({ label, onEdit, onReset }: { label: string; onEdit: () => void; onReset?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className={RECORD_ACTION_TRIGGER_BUTTON_CLASS}
        aria-label={`Actions for ${label}`}
        data-attr="property-pricing-row-menu"
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem data-attr="property-pricing-row-edit" onSelect={onEdit}>Edit pricing</DropdownMenuItem>
        {onReset ? <DropdownMenuItem data-attr="property-pricing-row-reset" onSelect={onReset}>Reset to default</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
