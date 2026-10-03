"use client";

import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { sharedRoomBedLabel } from "@/lib/public-shared-room-listing";

export function SharedApplicationSummaryCard({
  roomLabel,
  bedSlot,
  monthlyRent,
  applyMode,
  groupId,
  uploadedForms,
}: {
  roomLabel: string;
  bedSlot?: number;
  monthlyRent?: number;
  applyMode?: "bed" | "room";
  groupId?: string;
  uploadedForms?: boolean;
}) {
  if (!roomLabel.trim()) return null;
  const bedLine = bedSlot ? sharedRoomBedLabel(bedSlot) : null;
  const priceLine =
    typeof monthlyRent === "number" && monthlyRent > 0
      ? `${formatRoomPriceAmount(monthlyRent)}/mo`
      : null;
  const modeLine =
    applyMode === "room"
      ? "Whole room with roommates"
      : applyMode === "bed"
        ? "One bed"
        : null;

  return (
    <div
      className="rounded-2xl border border-border bg-accent/20 px-4 py-3"
      data-sr-summary
    >
      <p className="text-sm font-bold text-foreground">
        {[roomLabel, bedLine, priceLine].filter(Boolean).join(" · ")}
      </p>
      {modeLine ? <p className="mt-1 text-sm font-semibold text-foreground">{modeLine}</p> : null}
      {groupId?.trim() ? (
        <p className="mt-1 text-sm font-semibold text-foreground">Group {groupId.trim()}</p>
      ) : null}
      {uploadedForms ? (
        <p className="mt-1 text-sm font-semibold text-foreground">Uploaded application forms</p>
      ) : null}
    </div>
  );
}
