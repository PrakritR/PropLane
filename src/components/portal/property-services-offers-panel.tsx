"use client";

import { useMemo, useState } from "react";
import { ArrowLeftRight, CircleSlash, CreditCard, Wrench } from "lucide-react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { LeasingQuickAddRow } from "@/components/portal/leasing-quick-add-row";
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
import {
  missingServiceQuickAdds,
  serviceAppliesTo,
  serviceFromQuickAdd,
} from "@/lib/property-services-by-stay";
import {
  appliesToForTab,
  rowsInStay,
  stayCounts,
  stayLabel,
  stayTabsFor,
  type PropertyStay,
} from "@/lib/property-stay-tabs";


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

/**
 * Property Services = the services offered here (captain, Oct 5): tabs Long term · Short term, a service for
 * both stays in both, search + the round +, and a Quick add row. Requests live on the main Services page.
 */
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
  const [stayPick, setStayPick] = useState<PropertyStay>("long_term");
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ManagerListingServiceOption | null>(null);
  const [isNew, setIsNew] = useState(false);
  const confirm = useConfirm();

  const offers = useMemo(() => sub.serviceRequestOptions ?? [], [sub.serviceRequestOptions]);
  const q = query.trim().toLowerCase();

  // A stay the property does not allow still gets its tab while it holds services, so none is hidden.
  // Only a service for that stay alone holds the tab open: a both-stays service never forces a Short term tab.
  const counts = stayCounts(offers, (o) => o.appliesTo);
  const only = {
    long_term: offers.filter((o) => o.appliesTo === "long_term").length,
    short_term: offers.filter((o) => o.appliesTo === "short_term").length,
  };
  const tabItems = stayTabsFor(sub, only).map((id) => ({ id, label: stayLabel(id), count: counts[id] }));
  const stay: PropertyStay = tabItems.some((t) => t.id === stayPick) ? stayPick : (tabItems[0]?.id ?? "long_term");
  const showBothFact = tabItems.length > 1;

  // One list per stay: a per-request service and a monthly add-on are the same kind of offer; the row's
  // price fact says how it is billed.
  const filtered = useMemo(
    () => rowsInStay(offers, stay, (o) => o.appliesTo).filter((o) => !q || (o.name ?? "").toLowerCase().includes(q)),
    [offers, stay, q],
  );

  const quickAdds = missingServiceQuickAdds(offers);
  const quickAdd = (key: string) => {
    const row = serviceFromQuickAdd(key, stay);
    if (!row) return;
    const next: ManagerListingSubmissionV1 = { ...sub, serviceRequestOptions: [row, ...offers] };
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast("Could not add service.");
      return;
    }
    showToast(`${row.name} added.`);
    onUpdated();
  };

  const openAdd = () => {
    const row = createManagerListingServiceOption();
    row.billingCadence = "per_request";
    row.appliesTo = appliesToForTab(stay);
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

  return (
    <div data-ps40-page="services" data-attr="property-services-catalog">
      <PortalListControlStack
        className="plp-header-card mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={
          <LocalDestinationNav
            items={tabItems}
            activeId={stay}
            onChange={(id) => setStayPick(id as PropertyStay)}
            ariaLabel="Stay"
            appearance="command"
          />
        }
        activeDestinationId={stay}
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
          title: q ? "No matches" : "No services yet",
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
                {showBothFact && serviceAppliesTo(offer) === "both" ? (
                  <PortalRowFact icon={ArrowLeftRight} srLabel="Applies to">
                    Long and short term
                  </PortalRowFact>
                ) : null}
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

      <LeasingQuickAddRow entries={quickAdds} onAdd={quickAdd} noun="service" dataAttr="property-services-quick-add" />

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
        entityLabel="service"
      />
    </div>
  );
}
