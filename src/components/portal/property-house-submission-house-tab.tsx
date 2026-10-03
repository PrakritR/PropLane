"use client";

import { Input, Textarea } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import { FactRow, MultiPick } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { HOUSE_WIDE_AMENITY_PRESETS, listingAmenityLinesFromValue } from "@/data/manager-listing-presets";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const PROPERTY_KIND_OPTIONS = [
  { value: "house", label: "A house" },
  { value: "townhouse", label: "A townhouse" },
  { value: "condo", label: "A condo" },
  { value: "duplex", label: "A small building" },
  { value: "apartment", label: "An apartment" },
  { value: "other", label: "Something else" },
] as const;

export function propertyKindLabel(typeId: string | undefined): string {
  return PROPERTY_KIND_OPTIONS.find((o) => o.value === typeId)?.label ?? "Property type not set";
}

export function propertyFactsSummary(sub: ManagerListingSubmissionV1): string {
  const parts = [
    propertyKindLabel(sub.listingPropertyTypeId).replace(/^An? /, ""),
    sub.houseSizeSqft ? `${sub.houseSizeSqft.toLocaleString("en-US")} sq ft` : "Size not set",
    sub.yearBuilt ? `Built ${sub.yearBuilt}` : "Year not set",
    sub.address?.trim() || "No address yet",
  ];
  return parts.join(" · ");
}

export function propertyAmenitiesSummary(sub: ManagerListingSubmissionV1): string {
  const lines = (sub.amenitiesText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines.slice(0, 4).join(", ") + (lines.length > 4 ? "…" : "") : "Nothing added yet";
}

export function PropertySubmissionFactsEditor({
  sub,
  onPatch,
}: {
  sub: ManagerListingSubmissionV1;
  onPatch: (patch: Partial<ManagerListingSubmissionV1>) => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card" data-attr="property-house-facts-editor">
      <FactRow first label="Property type">
        <FieldSingleSelect
          hideLabel
          label="Property type"
          variant="cell"
          className="min-w-[180px] max-w-full"
          options={PROPERTY_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={sub.listingPropertyTypeId || "house"}
          onChange={(v) => onPatch({ listingPropertyTypeId: v })}
        />
      </FactRow>
      <FactRow label="Street address">
        <ListingAddressAutocomplete
          value={sub.address}
          placeholder="142 Ash St"
          onChange={(next) => onPatch({ address: next })}
          onSelect={(suggestion) => {
            onPatch({
              address: suggestion.address || suggestion.label,
              city: suggestion.city || sub.city,
              state: suggestion.state || sub.state,
              zip: suggestion.zip || sub.zip,
              neighborhood: suggestion.neighborhood || sub.neighborhood,
            });
          }}
        />
      </FactRow>
      <FactRow label="Neighborhood">
        <Input
          aria-label="Neighborhood"
          value={sub.neighborhood ?? ""}
          onChange={(e) => onPatch({ neighborhood: e.target.value })}
        />
      </FactRow>
      <FactRow label="Home size">
        <span className="relative flex w-36 items-center">
          <Input
            inputMode="numeric"
            value={sub.houseSizeSqft ?? ""}
            placeholder="1,450"
            aria-label="Home size in square feet"
            className="w-full pr-12 text-right"
            onChange={(e) => {
              const n = Number(e.target.value.replace(/[^0-9]/g, ""));
              onPatch({ houseSizeSqft: n > 0 ? n : undefined });
            }}
          />
          <span className="pointer-events-none absolute right-3 whitespace-nowrap text-[13px] font-semibold text-foreground/70">sq ft</span>
        </span>
      </FactRow>
      <FactRow label="Built">
        <Input
          inputMode="numeric"
          value={sub.yearBuilt ?? ""}
          placeholder="1962"
          aria-label="Year built"
          className="w-36 text-right"
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^0-9]/g, "").slice(0, 4));
            onPatch({ yearBuilt: n > 0 ? n : undefined });
          }}
        />
      </FactRow>
      <FactRow label="Property name">
        <Input
          aria-label="Property name"
          value={sub.buildingName ?? ""}
          placeholder={sub.address || "Magnolia House"}
          onChange={(e) => onPatch({ buildingName: e.target.value })}
        />
      </FactRow>
      <FactRow label="Description">
        <Textarea
          rows={4}
          aria-label="Property description"
          value={sub.houseOverview ?? ""}
          placeholder="Describe the home and who it suits…"
          onChange={(e) => onPatch({ houseOverview: e.target.value })}
        />
      </FactRow>
    </div>
  );
}

function HouseAmenityPick({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const lines = listingAmenityLinesFromValue(value);
  const labels = HOUSE_WIDE_AMENITY_PRESETS.map((p) => p.label);
  return (
    <MultiPick
      label="Amenities"
      options={labels}
      selected={lines}
      dataAttr="property-house-amenities-pick"
      onChange={(next) => {
        const picked = new Set(next);
        onChange(
          [...labels.filter((l) => picked.has(l)), ...next.filter((l) => !(labels as readonly string[]).includes(l))].join("\n"),
        );
      }}
    />
  );
}

export function PropertySubmissionAmenitiesEditor({
  sub,
  onPatch,
}: {
  sub: ManagerListingSubmissionV1;
  onPatch: (patch: Partial<ManagerListingSubmissionV1>) => void;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card px-1 py-1" data-attr="property-house-amenities-editor">
      <FactRow first label="Amenities">
        <HouseAmenityPick value={sub.amenitiesText ?? ""} onChange={(next) => onPatch({ amenitiesText: next })} />
      </FactRow>
    </div>
  );
}
