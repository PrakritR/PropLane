"use client";

import {
  PropertyTemplatePresetList,
  PROPERTY_TEMPLATE_PRESET_ROW_CLASS,
} from "@/components/portal/property-template-preset-list";
import { PROPERTY_LEASE_TYPE_OPTIONS } from "@/lib/property-lease-templates";
import { formatApplicationLeaseTermsLabel } from "@/lib/property-lease-template-sync";
import type { PropertyLeaseListingSeedKey } from "@/lib/property-lease-templates";

export type PropertyLeaseTemplateSeedOffer = {
  seedKey: PropertyLeaseListingSeedKey;
  kind: string;
  label: string;
  applicationLeaseTerms: string[];
};

/** Kept for callers that still import it; the row markup now lives in the shared list. */
export const PROPERTY_LEASE_PRESET_ROW_CLASS = PROPERTY_TEMPLATE_PRESET_ROW_CLASS;

function seedSubtitle(seed: PropertyLeaseTemplateSeedOffer): string {
  const kindMeta = PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === seed.kind);
  const terms = formatApplicationLeaseTermsLabel(seed.applicationLeaseTerms);
  const parts = [kindMeta?.description.trim() || null, terms ? `Applicants: ${terms}` : null].filter(Boolean);
  return parts.join(" · ") || "PropLane default lease";
}

/**
 * Default long-term / short-term leases not yet on this property — tap + to add.
 *
 * The "add a custom lease" affordance is NOT here: the panel renders the shared
 * `PortalListAddRow` for that, so the Lease tab reads the same as Requests and
 * Application.
 */
export function PropertyLeaseTemplateSuggestions({
  seeds,
  onAddSeed,
}: {
  seeds: PropertyLeaseTemplateSeedOffer[];
  onAddSeed: (seedKey: PropertyLeaseListingSeedKey) => void;
}) {
  return (
    <PropertyTemplatePresetList
      title="Add a lease"
      dataAttr="property-lease-template-suggestions"
      addDataAttrPrefix="property-lease-seed-add"
      presets={seeds.map((seed) => ({
        key: seed.seedKey,
        label: seed.label,
        subtitle: seedSubtitle(seed),
      }))}
      onAdd={(key) => onAddSeed(key as PropertyLeaseListingSeedKey)}
    />
  );
}
