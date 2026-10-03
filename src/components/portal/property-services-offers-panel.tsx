"use client";

import { useMemo, useState } from "react";
import { CircleSlash, CreditCard, Wrench } from "lucide-react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import {
  createManagerListingServiceOption,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
  type ServiceBillingCadence,
} from "@/lib/manager-listing-submission";
import { persistManagerListingSubmission, type ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";

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

/** Property Services catalog — studio property-tabs header (Services section tab + search + +). */
export function PropertyServicesOffersPanel({
  sub,
  saveTarget,
  managerUserId,
  propertyLabel: _propertyLabel,
  onUpdated,
  showToast,
}: Props) {
  void _propertyLabel;
  const [query, setQuery] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ManagerListingServiceOption | null>(null);
  const [isNew, setIsNew] = useState(false);
  const confirm = useConfirm();

  const offers = sub.serviceRequestOptions ?? [];
  const q = query.trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!q) return offers;
    return offers.filter((o) => (o.name ?? "").toLowerCase().includes(q));
  }, [offers, q]);

  const openAdd = () => {
    const row = createManagerListingServiceOption();
    row.billingCadence = "per_request";
    setEditing(row);
    setIsNew(true);
    setEditOpen(true);
  };

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

  const entityLabelFor = (offer: ManagerListingServiceOption) =>
    offerCadence(offer) === "per_request" ? "request service" : "add-on";

  return (
    <div data-ps40-page="services" data-attr="property-services-catalog">
      <PortalListControlStack
        className="plp-header-card mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={
          <LocalDestinationNav
            items={[{ id: "services", label: "Services" }]}
            activeId="services"
            onChange={() => {}}
            ariaLabel="Services"
            appearance="command"
          />
        }
        activeDestinationId="services"
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search services",
          dataAttr: "property-services-search",
        }}
        primary={
          <PortalPrimaryIconAction
            label="Add service"
            data-attr="property-services-add-top"
            onClick={openAdd}
          />
        }
      />

      <PortalRecordListSurface
        isEmpty={filtered.length === 0}
        emptyCard={{
          title: "No services yet",
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
        entityLabel={editing ? entityLabelFor(editing) : "service"}
      />
    </div>
  );
}
