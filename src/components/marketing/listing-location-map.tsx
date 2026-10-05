"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";

type LeafletMap = import("leaflet").Map;

const MAP_BOX_CLASS = "z-0 h-[min(22rem,48vh)] min-h-[220px] w-full rounded-2xl border border-border bg-accent/30";

export function ListingLocationMap({
  lat,
  lng,
  className,
}: {
  lat: number;
  lng: number;
  /** Extra classes on the map box (a phone preview shortens it, then restores it on tap). */
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    void import("leaflet").then((LeafletMod) => {
      const L = (LeafletMod as { default?: typeof import("leaflet") }).default ?? LeafletMod;
      if (cancelled || !containerRef.current) return;

      const map = L.map(containerRef.current, { scrollWheelZoom: false }).setView([lat, lng], 14);
      mapRef.current = map;

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const icon = L.divIcon({
        className: "border-0 bg-transparent",
        html: `<div style="width:22px;height:22px;border-radius:9999px;background:linear-gradient(135deg,#2f6bff,#5a8cff);border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.28)"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      L.marker([lat, lng], { icon }).addTo(map);

      requestAnimationFrame(() => map.invalidateSize());
    });

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [lat, lng]);

  // A resized box (the phone's short map expanding) needs the tiles re-laid.
  useEffect(() => {
    mapRef.current?.invalidateSize();
  }, [className]);

  return <div ref={containerRef} className={[MAP_BOX_CLASS, className].filter(Boolean).join(" ")} />;
}
