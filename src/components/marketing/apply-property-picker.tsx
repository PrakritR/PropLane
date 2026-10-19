"use client";

import { useMemo } from "react";
import type { MockProperty } from "@/data/types";
import { JourneyPicker, type JourneyPickerOption } from "@/components/public-site/journey-picker";

export function ApplyPropertyPicker({
  properties,
  onSelectProperty,
}: {
  properties: MockProperty[];
  onSelectProperty: (propertyId: string) => void;
}) {
  const options: JourneyPickerOption[] = useMemo(
    () =>
      properties.map((property) => ({
        id: property.id,
        title: property.title,
        place: property.address || property.neighborhood,
        figure: property.rentLabel,
        searchText: `${property.neighborhood} ${property.buildingName} ${property.unitLabel}`,
      })),
    [properties],
  );

  return (
    <div className="ps-j-stack" style={{ gap: 18 }}>
      <h2 className="ps-h3">Choose a home to apply for</h2>
      <JourneyPicker
        options={options}
        value={null}
        onChange={onSelectProperty}
        placeholder="Search by address, neighborhood, or property name"
        emptyMessage="No properties match your search."
        listEmptyMessage="No properties are available from this link."
        ariaLabel="Search properties to apply for"
        searchAbove={5}
      />
    </div>
  );
}
