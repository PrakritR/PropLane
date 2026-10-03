"use client";

import { useMemo, useState } from "react";
import { CircleSlash, CreditCard, Settings, Wrench } from "lucide-react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { PortalPropertySectionSettingsModal } from "@/components/portal/portal-property-section-settings-modal";
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import { PropertyServiceSettingsForm } from "@/components/portal/property-service-settings-form";
import {
  createManagerListingServiceOption,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
  type ServiceBillingCadence,
} from "@/lib/manager-listing-submission";
import { persistManagerListingSubmission, type ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";

type ServiceTab = "requests" | "addons";

function offerCadence(offer: ManagerListingServiceOption): ServiceBillingCadence {
  return offer.billingCadence ?? "per_request";
}

/** The row's price fact: "$40 · Per request"; "No price" when the manager set none. */
export function offerPriceFact(offer: ManagerListingServiceOption): string {
  const cadence =
    offerCadence(offer) === "per_request"
      ? "Per request"
      : offerCadence(offer) === "monthly"
        ? "Monthly"
        : "One time";
  return [offer.price?.trim(), cadence].filter(Boolean).join(" · ") || "No price";
}

type Props = {
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  propertyLabel: string;
  onUpdated: () => void;
  showToast: (m: string) => void;
};

/** Property Services catalog — Requests vs Add-ons tabs (C2-PRC9). */
export function PropertyServicesOffersPanel({
  sub,
  saveTarget,
  managerUserId,
  propertyLabel,
  onUpdated,
  showToast,
}: Props) {
  const [tab, setTab] = useState<ServiceTab>("requests");
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ManagerListingServiceOption | null>(null);
  const [isNew, setIsNew] = useState(false);
  const confirm = useConfirm();

  const offers = sub.serviceRequestOptions ?? [];
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    const cadenceFilter: ServiceBillingCadence = tab === "requests" ? "per_request" : "monthly";
    return offers.filter((o) => {
      const cad = offerCadence(o);
      const inTab =
        tab === "requests"
          ? cad === "per_request"
          : cad === "monthly" || cad === "one_time";
      if (!inTab) return false;
      if (!q) return true;
      return (o.name ?? "").toLowerCase().includes(q);
    });
  }, [offers, tab, q]);

  const requestCount = offers.filter((o) => offerCadence(o) === "per_request").length;
  const addonCount = offers.filter((o) => offerCadence(o) !== "per_request").length;

  const openAdd = () => {
    const row = createManagerListingServiceOption();
    row.billingCadence = tab === "requests" ? "per_request" : "monthly";
    setEditing(row);
    setIsNew(true);
    setEditOpen(true);
  };

  const addLabel = tab === "requests" ? "request service" : "add-on";

  const openEdit = (offer: ManagerListingServiceOption) => {
    setEditing(offer);
    setIsNew(false);
    setEditOpen(true);
  };

  const removeOffer = async (offer: ManagerListingServiceOption) => {
    if (!(await confirm({ description: `Delete ${offer.name.trim() || "this service"}?` }))) return;
    const next: ManagerListingSubmissionV1 = {
      ...sub,
      serviceRequestOptions: (sub.serviceRequestOptions ?? []).filter((o) => o.id !== offer.id),
    };
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast("Could not delete service.");
      return;
    }
    showToast("Service deleted.");
    onUpdated();
  };

  return (
    <div data-ps40-page="services" data-attr="property-services-catalog">
      <PortalListControlStack
        className="plp-header-card mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={
          <LocalDestinationNav
            items={[
              { id: "requests", label: "Requests", count: requestCount },
              { id: "addons", label: "Add-ons", count: addonCount },
            ]}
            activeId={tab}
            onChange={(id) => setTab(id as ServiceTab)}
            ariaLabel="Service types"
            appearance="command"
          />
        }
        activeDestinationId={tab}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search services",
          dataAttr: "property-services-search",
        }}
        actions={
          <PortalIconAction
            icon={Settings}
            label="Service settings"
            data-attr="ps40-svcSettings"
            onClick={() => setSettingsOpen(true)}
          />
        }
        primary={
          <PortalPrimaryIconAction
            label={addLabel}
            data-attr="property-services-add-top"
            onClick={openAdd}
          />
        }
      />

      <PortalRecordListSurface
        isEmpty={filtered.length === 0}
        emptyCard={{
          title: tab === "requests" ? "No request services yet" : "No add-ons yet",
          section: "services",
        }}
      >
        {filtered.map((offer) => (
          <PortalPropertyRecordRow
            key={offer.id}
            title={offer.name.trim() || "Service"}
            address={offer.description?.trim() || undefined}
            leading={<PortalRowIconTile icon={Wrench} />}
            leadingShape="square"
            facts={
              <>
                <PortalRowFact icon={CreditCard} srLabel="Price">
                  {offerPriceFact(offer)}
                </PortalRowFact>
                {offer.deposit?.trim() ? (
                  <PortalRowFact icon={CreditCard} srLabel="Deposit">
                    {`${offer.deposit.trim()} deposit`}
                  </PortalRowFact>
                ) : null}
                {!offer.available ? (
                  <PortalRowFact icon={CircleSlash} srLabel="Availability">
                    Turned off
                  </PortalRowFact>
                ) : null}
              </>
            }
            onOpen={() => openEdit(offer)}
            dataAttr="property-service-offer-row"
            actions={
              <RowActionsMenu
                label={offer.name.trim() || "Service"}
                items={[
                  { id: "edit", label: "Edit", onSelect: () => openEdit(offer) },
                  { id: "delete", label: "Delete", danger: true, onSelect: () => void removeOffer(offer) },
                ]}
              />
            }
          />
        ))}
      </PortalRecordListSurface>

      <PortalPropertySectionSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Service settings"
        propertyLabel={propertyLabel}
        dataAttr="property-services-settings"
      >
        <PropertyServiceSettingsForm
          sub={sub}
          saveTarget={saveTarget}
          managerUserId={managerUserId}
          onUpdated={onUpdated}
          showToast={showToast}
          onSave={() => setSettingsOpen(false)}
        />
      </PortalPropertySectionSettingsModal>

      <ServiceOfferingEditModal
        open={editOpen}
        offering={editing}
        isNew={isNew}
        sub={sub}
        saveTarget={saveTarget}
        managerUserId={managerUserId}
        onClose={() => {
          setEditOpen(false);
          setEditing(null);
        }}
        onSaved={() => {
          onUpdated();
          setEditOpen(false);
        }}
        showToast={showToast}
        entityLabel={tab === "requests" ? "request service" : "add-on"}
      />
    </div>
  );
}
