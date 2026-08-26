"use client";

import { Plus } from "lucide-react";
import { PORTAL_EDIT_ROW_ICON_BUTTON_CLASS } from "@/components/portal/portal-collapsible-edit-row";
import {
  LISTING_SERVICE_QUICK_ADDS,
  resolveServiceOfferPricing,
  type ListingServiceQuickAdd,
  type ManagerListingServiceOption,
} from "@/lib/manager-listing-submission";

/** Dashed preset row — matches application-question "off" rows with primary tint. */
export const SERVICE_REQUEST_PRESET_ROW_CLASS =
  "flex items-center justify-between gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2.5";

function presetSubtitle(preset: ListingServiceQuickAdd): string {
  const pricing = resolveServiceOfferPricing({
    name: preset.name,
    price: preset.price,
    deposit: preset.deposit,
  });
  const parts = [
    preset.description.trim() || null,
    pricing.price || null,
    pricing.deposit ? `Deposit ${pricing.deposit}` : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Suggested request type";
}

export function missingServiceRequestPresets(offers: ManagerListingServiceOption[]): ListingServiceQuickAdd[] {
  const activeNames = new Set(offers.map((o) => o.name.trim().toLowerCase()).filter(Boolean));
  return LISTING_SERVICE_QUICK_ADDS.filter((p) => !activeNames.has(p.name.trim().toLowerCase()));
}

/** Preset request types not yet on this property — tap + to open the offering editor. */
export function ServiceRequestCatalogSuggestions({
  offers,
  onAddPreset,
  onAddCustom,
  addCustomLabel = "Add custom request type",
}: {
  offers: ManagerListingServiceOption[];
  onAddPreset: (preset: ListingServiceQuickAdd) => void;
  onAddCustom?: () => void;
  addCustomLabel?: string;
}) {
  const missing = missingServiceRequestPresets(offers);

  if (missing.length === 0 && !onAddCustom) return null;

  return (
    <div className="space-y-2" data-attr="service-request-catalog-suggestions">
      {missing.length > 0 ? (
        <>
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Other service types</p>
          {missing.map((preset) => (
            <div key={preset.name} className={SERVICE_REQUEST_PRESET_ROW_CLASS}>
              <div className="min-w-0 flex-1 text-left">
                <p className="text-sm font-medium text-foreground">{preset.name}</p>
                <p className="mt-0.5 text-xs text-muted">{presetSubtitle(preset)}</p>
              </div>
              <button
                type="button"
                className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
                title={`Add ${preset.name}`}
                aria-label={`Add ${preset.name}`}
                data-attr={`service-request-preset-add-${preset.name.replace(/\s+/g, "-").toLowerCase()}`}
                onClick={() => onAddPreset(preset)}
              >
                <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden />
              </button>
            </div>
          ))}
        </>
      ) : null}
      {onAddCustom ? (
        <button
          type="button"
          className={`${SERVICE_REQUEST_PRESET_ROW_CLASS} w-full cursor-pointer justify-center text-center transition hover:border-primary/50 hover:bg-primary/[0.07]`}
          data-attr="service-request-add-custom"
          onClick={onAddCustom}
        >
          <span className="text-sm font-semibold text-primary">{addCustomLabel}</span>
        </button>
      ) : null}
    </div>
  );
}
