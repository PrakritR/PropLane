"use client";

import { ImageIcon, Video } from "lucide-react";
import { getHouseInfoValue, type HouseInfoV1 } from "@/lib/house-info";

const MOVE_IN_ACCESS_FIELDS: { section: "access" | "wifi"; key: string; label: string }[] = [
  { section: "access", key: "doorCode", label: "Door or lock code" },
  { section: "access", key: "gateCode", label: "Gate or building code" },
  { section: "access", key: "keyPickup", label: "Lockbox or key pickup" },
  { section: "access", key: "parking", label: "Parking" },
  { section: "wifi", key: "network", label: "Wi-Fi network" },
  { section: "wifi", key: "password", label: "Wi-Fi password" },
];

export function MoveInResidentPreviewCard({
  propertyLabel,
  title,
  instructions,
  photoDataUrls,
  videoDataUrl,
  houseInfo,
  showWholeHouseAccess,
}: {
  propertyLabel: string;
  title: string;
  instructions: string;
  photoDataUrls: string[];
  videoDataUrl: string | null;
  houseInfo?: HouseInfoV1 | null;
  showWholeHouseAccess?: boolean;
}) {
  const extras =
    showWholeHouseAccess && houseInfo
      ? MOVE_IN_ACCESS_FIELDS
          .map((f) => {
            const value = getHouseInfoValue(houseInfo, f.section, f.key).trim();
            return value ? { label: f.label, value } : null;
          })
          .filter(Boolean)
      : [];

  return (
    <div className="space-y-3 text-sm" data-attr="move-in-resident-preview-card">
      <div>
        <p className="text-xs text-muted">{propertyLabel}</p>
        <p className="font-semibold text-foreground">Move-in · {title}</p>
      </div>
      {instructions.trim() ? (
        <p className="whitespace-pre-wrap leading-relaxed text-foreground">{instructions}</p>
      ) : null}
      {extras.length ? (
        <dl className="space-y-2 border-t border-border pt-3">
          {extras.map((row) => (
            <div key={row!.label} className="flex flex-wrap justify-between gap-2">
              <dt className="text-xs text-muted">{row!.label}</dt>
              <dd className="font-mono text-sm font-semibold">{row!.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {photoDataUrls.length ? (
        <div className="flex flex-wrap gap-2">
          {photoDataUrls.slice(0, 6).map((_, i) => (
            <div
              key={i}
              className="flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-muted/30 text-muted"
              aria-hidden
            >
              <ImageIcon className="h-5 w-5" />
            </div>
          ))}
        </div>
      ) : null}
      {videoDataUrl ? (
        <div className="flex items-center gap-2 text-muted">
          <Video className="h-4 w-4" />
          <span>Walkthrough video</span>
        </div>
      ) : null}
      {!instructions.trim() && !extras.length && !photoDataUrls.length && !videoDataUrl ? (
        <p className="text-muted">Nothing added yet</p>
      ) : null}
    </div>
  );
}
