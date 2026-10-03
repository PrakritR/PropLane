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
import { persistManagerListingSubmission, type ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";
import {
  propertyPricingBundleSummary,
  propertyPricingRoomAmount,
  propertyPricingRoomSummary,
  propertyPricingWholeHouseSummary,
  roomPricingSourceLabel,
} from "@/lib/property-pricing-summary";
import { resetRoomToWorkspaceDefault } from "@/lib/property-pricing-publish";
import {
  normalizeWorkspacePricingDefaults,
  type WorkspacePricingDefaults,
} from "@/lib/workspace-pricing-defaults";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RECORD_ACTION_TRIGGER_BUTTON_CLASS, RECORD_ACTION_TRIGGER_ICON_CLASS } from "@/components/ui/record-action-menu";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { MoreHorizontal } from "lucide-react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { Settings } from "lucide-react";

type PricingTab = "rooms" | "bundles" | "whole";

type Props = {
  submission: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  propertyLabel: string;
  onUpdated: () => void;
  showToast: (message: string) => void;
  workspacePricingDefaults?: WorkspacePricingDefaults;
};

export function PropertyPricingPanel({
  submission,
  saveTarget,
  managerUserId,
  propertyLabel,
  onUpdated,
  showToast,
  workspacePricingDefaults: workspacePricingDefaultsProp,
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

  const persist = (next: ManagerListingSubmissionV1) => {
    const normalized = normalizeManagerListingSubmissionV1(next);
    if (!persistManagerListingSubmission(saveTarget, managerUserId, normalized)) {
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

  const addForTab = () => {
    if (tab === "bundles") {
      const next = emptyBundleRow();
      const draft = normalizeManagerListingSubmissionV1({ ...sub, bundles: [...bundles, next] });
      if (!persist(draft)) return;
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

  const addLabel =
    tab === "bundles" ? "bundle" : tab === "whole" ? "whole house price" : "room price";

  const tabItems = [
    { id: "rooms" as const, label: "Rooms", count: rooms.length },
    { id: "bundles" as const, label: "Bundles", count: bundles.length },
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
              const source = roomPricingSourceLabel(meta);
              const summary = propertyPricingRoomSummary(room, sub, meta);
              const canReset =
                meta?.priceSource === "default" ||
                meta?.priceSource === "own" ||
                room.monthlyRent > 0;
              return (
                <PortalPropertyRecordRow
                  key={room.id}
                  title={room.name.trim() || "Room"}
                  address={source ? source : undefined}
                  summary={summary}
                  amount={propertyPricingRoomAmount(room)}
                  onOpen={() => openSubject({ kind: "room", roomId: room.id })}
                  dataAttr="property-pricing-room-row"
                  actions={
                    canReset
                      ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              type="button"
                              className={RECORD_ACTION_TRIGGER_BUTTON_CLASS}
                              aria-label={`Actions for ${room.name.trim() || "Room"}`}
                            >
                              <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() => {
                                  const next = resetRoomToWorkspaceDefault(sub, room.id, workspacePricingDefaults);
                                  if (!next) {
                                    showToast("No workspace default for this room.");
                                    return;
                                  }
                                  persist(next);
                                  showToast("Room reset to workspace default.");
                                }}
                              >
                                Reset to default
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )
                      : undefined
                  }
                />
              );
            })
          : null}

        {tab === "bundles"
          ? filteredBundles.map((bundle) => (
              <PortalPropertyRecordRow
                key={bundle.id}
                title={bundle.label.trim() || "Bundle"}
                summary={propertyPricingBundleSummary(bundle, sub)}
                amount={
                  bundle.price?.trim()
                    ? `${bundle.price.replace(/\/mo$/i, "").trim()}/mo`
                    : "—"
                }
                onOpen={() => openSubject({ kind: "bundle", bundleId: bundle.id })}
                dataAttr="property-pricing-bundle-row"
              />
            ))
          : null}

        {tab === "whole" && showWholeTab ? (
          <PortalPropertyRecordRow
            title="Whole house"
            summary={propertyPricingWholeHouseSummary(sub)}
            amount={
              propertyPricingWholeHouseSummary(sub).includes("/mo")
                ? propertyPricingWholeHouseSummary(sub).split(" · ").pop() ?? "—"
                : "—"
            }
            onOpen={() => openSubject({ kind: "whole" })}
            dataAttr="property-pricing-whole-row"
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
        />
      ) : null}
    </div>
  );
}
