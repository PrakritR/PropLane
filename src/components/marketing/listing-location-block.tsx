"use client";

import { useState } from "react";
import type { MockProperty } from "@/data/types";
import { useListingMapCoords } from "@/hooks/use-listing-map-coords";
import { ListingLocationMap } from "@/components/marketing/listing-location-map";

/** A phone's short map: about the height of two rows, so Location does not eat the screen. */
const PHONE_SHORT_MAP = "max-lg:!h-[7.5rem] max-lg:!min-h-0";

export function ListingLocationBlock({
  property,
  embedded = false,
  shortOnPhone = false,
}: {
  property: Pick<MockProperty, "address" | "zip" | "neighborhood" | "unitLabel" | "mapLat" | "mapLng">;
  /** When true, render map + address only (parent supplies section chrome). */
  embedded?: boolean;
  /**
   * Manager preview on a phone: the map starts short and a tap expands it to the
   * full map. Wider screens always show the full map.
   */
  shortOnPhone?: boolean;
}) {
  const { coords, loading } = useListingMapCoords(property);
  const [expanded, setExpanded] = useState(false);
  const short = shortOnPhone && !expanded;
  const addressLine = [property.address?.trim(), property.zip?.trim()].filter(Boolean).join(", ");

  const body = (
    <>
      <p className="text-sm text-muted">{addressLine}</p>
      <div className={`relative overflow-hidden rounded-2xl ${short ? "mt-3" : "mt-4"}`} data-attr="listing-location-map">
        {loading || !coords ? (
          <div
            className={`flex h-[min(22rem,48vh)] min-h-[220px] w-full items-center justify-center rounded-2xl border border-border bg-accent/30 text-sm text-muted ${short ? PHONE_SHORT_MAP : ""}`}
            aria-busy="true"
            aria-label="Loading map"
          >
            Locating address…
          </div>
        ) : (
          <ListingLocationMap lat={coords.lat} lng={coords.lng} className={short ? PHONE_SHORT_MAP : undefined} />
        )}
        {short ? (
          <button
            type="button"
            className="absolute inset-0 z-[500] cursor-pointer rounded-2xl lg:hidden"
            aria-label="Expand map"
            data-attr="listing-location-map-expand"
            onClick={() => setExpanded(true)}
          />
        ) : null}
      </div>
    </>
  );

  if (embedded) return body;

  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
      <h2 className="text-xl font-bold tracking-tight text-foreground">Location</h2>
      {body}
    </div>
  );
}
