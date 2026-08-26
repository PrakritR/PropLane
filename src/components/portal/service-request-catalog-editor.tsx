"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import { ServiceRequestCatalogSuggestions } from "@/components/portal/service-request-catalog-suggestions";
import {
  createManagerListingServiceOption,
  resolveServiceOfferPricing,
  type ListingServiceQuickAdd,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { ManagerPropertySaveTarget } from "@/lib/manager-property-save-target";

type RequestsSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

function requestOfferSubtitle(offer: ManagerListingServiceOption): string {
  const parts = [
    offer.price?.trim() || null,
    offer.deposit?.trim() ? `Deposit ${offer.deposit.trim()}` : null,
    !offer.available ? "Unavailable" : null,
  ].filter(Boolean);
  return parts.join(" · ") || "No price set";
}

/** Shared request catalog — active list, preset suggestions, and offering editor. */
export function ServiceRequestCatalogEditor({
  sub,
  saveTarget,
  managerUserId,
  onUpdated,
  showToast,
  onOfferSaved,
  onRegisterAddCustom,
  onNestedModalOpenChange,
}: {
  sub: ManagerListingSubmissionV1;
  saveTarget: RequestsSaveTarget;
  managerUserId: string;
  onUpdated: () => void;
  showToast: (m: string) => void;
  onOfferSaved?: (offerId: string) => void;
  /** Parent header/footer — opens the custom add offering form. */
  onRegisterAddCustom?: (openAddCustom: (() => void) | null) => void;
  /** Offering add/edit modal — parent should block dismiss while open. */
  onNestedModalOpenChange?: (open: boolean) => void;
}) {
  const offers = sub.serviceRequestOptions ?? [];

  const [editOpen, setEditOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<ManagerListingServiceOption | null>(null);
  const [isNewOffer, setIsNewOffer] = useState(false);
  const [pendingSelectOfferId, setPendingSelectOfferId] = useState<string | null>(null);

  const openEdit = useCallback((offer: ManagerListingServiceOption | null, isNew: boolean) => {
    setEditingOffer(offer);
    setIsNewOffer(isNew);
    setEditOpen(true);
  }, []);

  const openAddPreset = (preset: ListingServiceQuickAdd) => {
    const pricing = resolveServiceOfferPricing({
      name: preset.name,
      price: preset.price,
      deposit: preset.deposit,
    });
    const row = {
      ...createManagerListingServiceOption(preset.name, preset.description),
      price: pricing.price,
      deposit: pricing.deposit,
    };
    setPendingSelectOfferId(row.id);
    openEdit(row, true);
  };

  const openAddCustom = useCallback(() => {
    const row = createManagerListingServiceOption();
    setPendingSelectOfferId(row.id);
    openEdit(row, true);
  }, [openEdit]);

  useEffect(() => {
    onRegisterAddCustom?.(openAddCustom);
    return () => onRegisterAddCustom?.(null);
  }, [onRegisterAddCustom, openAddCustom]);

  useEffect(() => {
    onNestedModalOpenChange?.(editOpen);
  }, [editOpen, onNestedModalOpenChange]);

  const closeEdit = () => {
    setEditOpen(false);
    setEditingOffer(null);
    setIsNewOffer(false);
    setPendingSelectOfferId(null);
  };

  const onSaved = () => {
    onUpdated();
    if (pendingSelectOfferId) {
      onOfferSaved?.(pendingSelectOfferId);
      setPendingSelectOfferId(null);
    }
  };

  if (!saveTarget) return null;

  return (
    <>
      <PortalPropertyDetailSection contentClassName="space-y-0">
        {offers.length > 0 ? (
          offers.map((offer) => (
            <div key={offer.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{offer.name.trim() || "Untitled request"}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {offer.description?.trim()
                    ? `${offer.description.trim()} · ${requestOfferSubtitle(offer)}`
                    : requestOfferSubtitle(offer)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                data-attr={`catalog-request-edit-${offer.id}`}
                onClick={() => openEdit(offer, false)}
              >
                Edit
              </Button>
            </div>
          ))
        ) : (
          <p className="px-1 py-2 text-sm text-muted">
            No service types yet. Add a preset below or tap Add.
          </p>
        )}
      </PortalPropertyDetailSection>

      <div className="mt-4 px-1">
        <ServiceRequestCatalogSuggestions offers={offers} onAddPreset={openAddPreset} />
      </div>

      <ServiceOfferingEditModal
        open={editOpen}
        offering={editingOffer}
        isNew={isNewOffer}
        sub={sub}
        saveTarget={saveTarget}
        managerUserId={managerUserId}
        onClose={closeEdit}
        onSaved={onSaved}
        showToast={showToast}
        entityLabel="request type"
      />
    </>
  );
}
