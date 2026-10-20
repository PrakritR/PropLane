"use client";

import { useEffect, useState } from "react";
import type { MockProperty } from "@/data/types";
import { listingGeocodeQuery, parseGeocodeResult } from "@/lib/geocode-address";
import { listingFallbackMapCenter } from "@/lib/listing-map";

export function useListingMapCoords(
  property: Pick<MockProperty, "address" | "zip" | "neighborhood" | "unitLabel" | "mapLat" | "mapLng"> &
    Partial<Pick<MockProperty, "state" | "listingSubmission">>,
): { coords: { lat: number; lng: number } | null; loading: boolean; geocoded: boolean } {
  const hasStored =
    property.mapLat != null &&
    property.mapLng != null &&
    Number.isFinite(property.mapLat) &&
    Number.isFinite(property.mapLng);

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(() =>
    hasStored ? { lat: property.mapLat!, lng: property.mapLng! } : null,
  );
  const [loading, setLoading] = useState(!hasStored);
  const [geocoded, setGeocoded] = useState(hasStored);

  useEffect(() => {
    if (hasStored) {
      setCoords({ lat: property.mapLat!, lng: property.mapLng! });
      setLoading(false);
      setGeocoded(true);
      return;
    }

    // Street + city/state + ZIP when the listing carries them, so a street name shared with another part of the
    // metro cannot win over the right one.
    const query = listingGeocodeQuery({
      ...property,
      city: property.listingSubmission?.city,
      state: property.state ?? property.listingSubmission?.state,
    });
    if (!query) {
      setCoords(listingFallbackMapCenter(property as MockProperty));
      setLoading(false);
      setGeocoded(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const params = new URLSearchParams({ q: query });
    void fetch(`/api/geocode?${params.toString()}`, { cache: "force-cache" })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as unknown;
      })
      .then((data) => {
        if (cancelled) return;
        const parsed = parseGeocodeResult(data);
        if (parsed) {
          setCoords(parsed);
          setGeocoded(true);
        } else {
          setCoords(listingFallbackMapCenter(property as MockProperty));
          setGeocoded(false);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCoords(listingFallbackMapCenter(property as MockProperty));
        setGeocoded(false);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    hasStored,
    property.address,
    property.zip,
    property.neighborhood,
    property.unitLabel,
    property.state,
    property.listingSubmission?.city,
    property.listingSubmission?.state,
    property.mapLat,
    property.mapLng,
  ]);

  return { coords, loading, geocoded };
}
