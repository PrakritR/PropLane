"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import {
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import {
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
} from "@/components/portal/portal-list-add-row";
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import { ServiceRequestCatalogSuggestions } from "@/components/portal/service-request-catalog-suggestions";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  createManagerListingServiceOption,
  resolveServiceOfferPricing,
  type ListingServiceQuickAdd,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
} from "@/lib/manager-property-save-target";

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
  onBulkActionsChange,
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
  /**
   * When set (e.g. Edit service types modal), selection actions render in the
   * parent dialog footer instead of a fixed `BulkActionBar` behind the overlay.
   */
  onBulkActionsChange?: (actions: ReactNode | null) => void;
}) {
  const offers = sub.serviceRequestOptions ?? [];
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(offers.length);

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
    // The bar exists to reach this editor; leaving the row ticked afterwards
    // just parks a floating bar over a row the manager is done with.
    clearSelection();
  };

  const onSaved = () => {
    onUpdated();
    if (pendingSelectOfferId) {
      onOfferSaved?.(pendingSelectOfferId);
      setPendingSelectOfferId(null);
    }
  };

  const selectedOffers = useMemo(
    () => offers.filter((offer) => selectedIds.has(offer.id)),
    [offers, selectedIds],
  );

  const selectedOfferId = selectedIds.size === 1 ? selectedOffers[0]?.id ?? null : null;

  useEffect(() => {
    if (!onBulkActionsChange) return;
    if (!selectedOfferId) {
      onBulkActionsChange(null);
      return;
    }
    const offerId = selectedOfferId;
    onBulkActionsChange(
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr="catalog-request-bulk-edit"
        onClick={() => {
          const offer = offers.find((row) => row.id === offerId);
          if (offer) openEdit(offer, false);
        }}
      >
        Edit service
      </Button>,
    );
  }, [offers, onBulkActionsChange, openEdit, selectedOfferId]);

  if (!saveTarget) return null;

  return (
    <>
      <PortalPropertyDetailSection contentClassName="space-y-0">
        {offers.length > 0 ? (
          offers.map((offer) => (
            <div key={offer.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  checked={selectedIds.has(offer.id)}
                  data-attr={`catalog-request-select-${offer.id}`}
                  onChange={() => toggleSelected(offer.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">{offer.name.trim() || "Untitled request"}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {offer.description?.trim()
                      ? `${offer.description.trim()} · ${requestOfferSubtitle(offer)}`
                      : requestOfferSubtitle(offer)}
                  </p>
                </div>
              </label>
            </div>
          ))
        ) : (
          <p className="px-1 py-2 text-sm text-muted">
            No service types yet. Add a preset below or create a custom type.
          </p>
        )}
      </PortalPropertyDetailSection>

      <div className="px-3 py-4 max-md:px-2.5 sm:py-5">
        <ServiceRequestCatalogSuggestions offers={offers} onAddPreset={openAddPreset} />
      </div>

      <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
        <PortalListAddRow
          label="Add"
          ariaLabel="Add custom service type"
          icon={PORTAL_LIST_ADD_ICONS.service}
          onClick={openAddCustom}
          dataAttr="service-request-add-custom"
        />
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

      {/*
        Edit is the only action out here. Delete already lives inside the
        editor, next to what it would destroy — a delete sitting in a floating
        bar, one click from a row you may have ticked by accident, is the wrong
        distance from a destructive action.
      */}
      {!onBulkActionsChange && selectedOfferId ? (
        <BulkActionBar count={selectedIds.size} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            <Button
              type="button"
              variant="outline"
              className={PORTAL_BULK_BAR_BTN}
              data-attr="catalog-request-bulk-edit"
              onClick={() => {
                const offer = offers.find((row) => row.id === selectedOfferId);
                if (offer) openEdit(offer, false);
              }}
            >
              Edit service
            </Button>
          </div>
        </BulkActionBar>
      ) : null}
    </>
  );
}
