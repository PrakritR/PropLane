"use client";

import { Plus } from "lucide-react";
import { PORTAL_EDIT_ROW_ICON_BUTTON_CLASS } from "@/components/portal/portal-collapsible-edit-row";
import { PROPERTY_LEASE_TYPE_OPTIONS } from "@/lib/property-lease-templates";
import { formatApplicationLeaseTermsLabel } from "@/lib/property-lease-template-sync";
import type { PropertyLeaseListingSeedKey } from "@/lib/property-lease-templates";

export type PropertyLeaseTemplateSeedOffer = {
  seedKey: PropertyLeaseListingSeedKey;
  kind: string;
  label: string;
  applicationLeaseTerms: string[];
};

/** Dashed preset row — matches request-type and application-question suggestions. */
export const PROPERTY_LEASE_PRESET_ROW_CLASS =
  "flex items-center justify-between gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2.5";

function seedSubtitle(seed: PropertyLeaseTemplateSeedOffer): string {
  const kindMeta = PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === seed.kind);
  const terms = formatApplicationLeaseTermsLabel(seed.applicationLeaseTerms);
  const parts = [kindMeta?.description.trim() || null, terms ? `Applicants: ${terms}` : null].filter(Boolean);
  return parts.join(" · ") || "PropLane default lease";
}

/** Default long-term / short-term leases not yet on this property — tap + to add. */
export function PropertyLeaseTemplateSuggestions({
  seeds,
  onAddSeed,
  onAddCustom,
}: {
  seeds: PropertyLeaseTemplateSeedOffer[];
  onAddSeed: (seedKey: PropertyLeaseListingSeedKey) => void;
  onAddCustom?: () => void;
}) {
  if (seeds.length === 0 && !onAddCustom) return null;

  return (
    <div className="space-y-2" data-attr="property-lease-template-suggestions">
      {seeds.length > 0 ? (
        <>
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Add a lease</p>
          {seeds.map((seed) => (
            <div key={seed.seedKey} className={PROPERTY_LEASE_PRESET_ROW_CLASS}>
              <div className="min-w-0 flex-1 text-left">
                <p className="text-sm font-medium text-foreground">{seed.label}</p>
                <p className="mt-0.5 text-xs text-muted">{seedSubtitle(seed)}</p>
              </div>
              <button
                type="button"
                className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
                title={`Add ${seed.label}`}
                aria-label={`Add ${seed.label}`}
                data-attr={`property-lease-seed-add-${seed.seedKey}`}
                onClick={() => onAddSeed(seed.seedKey)}
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
          className={`${PROPERTY_LEASE_PRESET_ROW_CLASS} w-full cursor-pointer justify-center text-center transition hover:border-primary/50 hover:bg-primary/[0.07]`}
          data-attr="property-lease-add-custom"
          onClick={onAddCustom}
        >
          <span className="text-sm font-medium text-foreground">Add custom lease</span>
        </button>
      ) : null}
    </div>
  );
}
