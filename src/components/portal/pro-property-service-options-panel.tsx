"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import { PortalEditRow } from "@/components/portal/portal-edit-row";
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import {
  createManagerListingServiceOption,
  LISTING_SERVICE_QUICK_ADDS,
  resolveServiceOfferPricing,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { persistManagerListingSubmission } from "@/lib/manager-property-save-target";

type ServiceOptionsSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

function serviceOfferSubtitle(offer: ManagerListingServiceOption): string {
  const parts = [
    offer.price,
    offer.deposit ? `Deposit ${offer.deposit}` : null,
    !offer.available ? "Unavailable" : null,
  ].filter(Boolean);
  return parts.join(" · ") || "No price set";
}

/**
 * Per-property services editor — the amenity/add-on catalog (parking, storage,
 * cleaning package, etc.) residents can request. Stored on the listing submission
 * (`serviceRequestOptions`) so it persists with the property record.
 */
export function ManagerPropertyServiceOptionsPanel({
  sub,
  saveTarget,
  managerUserId,
  onUpdated,
  showToast,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: ServiceOptionsSaveTarget;
  managerUserId: string | null;
  onUpdated: () => void;
  showToast: (m: string) => void;
}) {
  const [listModalOpen, setListModalOpen] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<ManagerListingServiceOption | null>(null);
  const [isNewOffer, setIsNewOffer] = useState(false);

  const offers = sub.serviceRequestOptions ?? [];
  const hasPreview = offers.length > 0;

  if (!saveTarget || !managerUserId) return null;

  const openEdit = (offer: ManagerListingServiceOption | null, isNew: boolean) => {
    setEditingOffer(offer);
    setIsNewOffer(isNew);
    setEditOpen(true);
  };

  const closeEdit = () => {
    setEditOpen(false);
    setEditingOffer(null);
    setIsNewOffer(false);
  };

  const removeSingleOffer = (offerId: string) => {
    const nextOffers = offers.filter((o) => o.id !== offerId);
    const next: ManagerListingSubmissionV1 = { ...sub, serviceRequestOptions: nextOffers };
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast("Could not remove service.");
      return;
    }
    showToast("Service removed.");
    onUpdated();
  };

  const openListModal = () => setListModalOpen(true);
  const closeListModal = () => setListModalOpen(false);

  const addQuickAdd = (preset: (typeof LISTING_SERVICE_QUICK_ADDS)[number]) => {
    if (offers.some((o) => o.name.trim().toLowerCase() === preset.name.toLowerCase())) {
      showToast(`${preset.name} is already on this listing.`);
      return;
    }
    const pricing = resolveServiceOfferPricing({ name: preset.name, price: preset.price, deposit: preset.deposit });
    const row = {
      ...createManagerListingServiceOption(preset.name, preset.description),
      price: pricing.price,
      deposit: pricing.deposit,
    };
    openEdit(row, true);
  };

  return (
    <>
      <PortalCollapsibleSection
        title="Services"
        expanded={previewExpanded}
        onExpandedChange={setPreviewExpanded}
        collapsible={hasPreview}
        toggleDataAttr="services-section-toggle"
        headerActions={
          <Button
            type="button"
            variant="outline"
            className="h-8 rounded-full px-3 text-xs"
            data-attr="service-options-add"
            onClick={openListModal}
          >
            {hasPreview ? "Edit services" : "Add"}
          </Button>
        }
        contentClassName="max-h-[min(50vh,420px)] overflow-y-auto overscroll-contain px-4 py-3"
      >
        {hasPreview ? (
          <div className="space-y-2">
            {offers.map((offer) => (
              <PortalEditRow
                key={offer.id}
                title={offer.name}
                subtitle={serviceOfferSubtitle(offer)}
                clickDataAttr={`service-preview-edit-${offer.id}`}
                onClick={() => openEdit(offer, false)}
                onRemove={() => removeSingleOffer(offer.id)}
                removeTitle={`Remove ${offer.name}`}
                removeDataAttr="service-option-remove-one"
              />
            ))}
          </div>
        ) : null}
      </PortalCollapsibleSection>

      <Modal open={listModalOpen} title="Services" onClose={closeListModal} panelClassName="max-w-2xl">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {LISTING_SERVICE_QUICK_ADDS.map((preset) => (
              <Button
                key={preset.name}
                type="button"
                variant="outline"
                className="h-7 rounded-full px-2.5 text-[11px]"
                onClick={() => addQuickAdd(preset)}
              >
                + {preset.name}
              </Button>
            ))}
          </div>

          {offers.length === 0 ? (
            <p className="text-sm text-muted">No offerings yet. Use a quick-add chip or add one below.</p>
          ) : (
            offers.map((offer) => (
              <PortalEditRow
                key={offer.id}
                title={offer.name.trim() || "Untitled offering"}
                subtitle={serviceOfferSubtitle(offer)}
                clickDataAttr={`service-offering-edit-${offer.id}`}
                onClick={() => openEdit(offer, false)}
                onRemove={() => removeSingleOffer(offer.id)}
                removeTitle="Remove offering"
                removeDataAttr="service-option-remove"
              />
            ))
          )}

          <Button
            type="button"
            variant="outline"
            className="rounded-full"
            onClick={() => openEdit(null, true)}
          >
            + Add offering
          </Button>
        </div>
      </Modal>

      <ServiceOfferingEditModal
        open={editOpen}
        offering={editingOffer}
        isNew={isNewOffer}
        sub={sub}
        saveTarget={saveTarget}
        managerUserId={managerUserId}
        onClose={closeEdit}
        onSaved={onUpdated}
        showToast={showToast}
      />
    </>
  );
}
