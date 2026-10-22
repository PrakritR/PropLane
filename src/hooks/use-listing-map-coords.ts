"use client";

import { useEffect, useState } from "react";
import type { MockProperty } from "@/data/types";
import { parseGeocodeResult } from "@/lib/geocode-address";
import { listingFallbackMapCenter } from "@/lib/listing-map";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The listing map's pin. The server resolves it with the listing payload (ZIP-verified,
 * `listing-geocode.server`), so a stored `mapLat` / `mapLng` is used as it stands.
 *
 * Without one the page shipped before that bounded lookup landed, so the SAME ZIP-verified lookup is asked
 * again here through `/api/listing-geocode`, by property ID only - the route reads the stored address itself
 * (it reads the cache the first one is filling). There is deliberately no free-text `/api/geocode` fallback:
 * that path matched a street name in the wrong neighbourhood, which is the regression the server lookup
 * exists to fix. Without a stored listing to ask about, the map draws its neutral fallback centre.
 */
export function useListingMapCoords(
  property: Pick<MockProperty, "id" | "address" | "zip" | "neighborhood" | "unitLabel" | "mapLat" | "mapLng"> &
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

    const propertyId = property.id?.trim() ?? "";
    if (!UUID.test(propertyId)) {
      setCoords(listingFallbackMapCenter(property as MockProperty));
      setLoading(false);
      setGeocoded(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void fetch(`/api/listing-geocode?propertyId=${encodeURIComponent(propertyId)}`, { cache: "force-cache" })
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
    property.id,
    property.address,
    property.zip,
    property.neighborhood,
    property.unitLabel,
    property.mapLat,
    property.mapLng,
  ]);

  return { coords, loading, geocoded };
}
