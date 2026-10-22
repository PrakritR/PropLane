"use client";

import { useEffect, useState } from "react";
import type { MockProperty } from "@/data/types";
import { parseGeocodeResult } from "@/lib/geocode-address";
import { listingFallbackMapCenter } from "@/lib/listing-map";

/**
 * The listing map's pin. The server resolves it with the listing payload (ZIP-verified,
 * `listing-geocode.server`), so a stored `mapLat` / `mapLng` is used as it stands.
 *
 * Without one the page shipped before that bounded lookup landed, so the SAME ZIP-verified lookup is asked
 * again here through `/api/listing-geocode` (it reads the cache the first one is filling). There is
 * deliberately no free-text `/api/geocode` fallback: that path matched a street name in the wrong
 * neighbourhood, which is the regression the server lookup exists to fix. With no ZIP there is nothing to
 * verify a hit against, so the map draws its neutral fallback centre.
 */
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

    const zip = property.zip?.trim() ?? "";
    if (!/^\d{5}(?:-\d{4})?$/.test(zip)) {
      setCoords(listingFallbackMapCenter(property as MockProperty));
      setLoading(false);
      setGeocoded(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const params = new URLSearchParams({ zip });
    if (property.address?.trim()) params.set("address", property.address.trim());
    const city = property.listingSubmission?.city?.trim();
    if (city) params.set("city", city);
    const state = (property.state ?? property.listingSubmission?.state)?.trim();
    if (state) params.set("state", state);

    void fetch(`/api/listing-geocode?${params.toString()}`, { cache: "force-cache" })
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
