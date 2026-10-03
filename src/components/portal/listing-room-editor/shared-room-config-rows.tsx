"use client";

import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { FactRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { sharedRoomPricingSummaryLine } from "@/lib/shared-room-display";

function formatRentDollars(amount: number): string {
  if (!amount || amount <= 0) return "Not set";
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: amount % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

const LEASE_OPTIONS = [
  { value: "property_default", label: "Property default" },
  { value: "individual", label: "One lease per resident" },
  { value: "joint", label: "One joint lease for roommates" },
] as const;

function pricingSummary(room: ManagerRoomSubmission): string {
  const capacity = room.occupancyCapacity ?? 1;
  const rent = room.monthlyRent ?? 0;
  const line = sharedRoomPricingSummaryLine(capacity, rent);
  if (room.residentPricing === "per_resident") {
    const beds = room.residentPrices ?? [];
    if (beds.length) {
      const parts = beds.map((row, i) => {
        const amount = row.monthlyRent ?? rent;
        return `Bed ${i + 1}: ${formatRentDollars(amount)}`;
      });
      return `Per bed · ${parts.join(" · ")}`;
    }
    return line ? `Per bed · ${line}` : "Per bed · Set rents on Payments";
  }
  if (rent > 0) {
    const share = capacity > 1 ? rent / capacity : rent;
    return `Whole room · ${formatRentDollars(rent)}/mo (${formatRentDollars(share)} each)`;
  }
  return line || "Set on Payments";
}

export function SharedRoomConfigRows({
  room,
  who,
  onRoom,
}: {
  room: ManagerRoomSubmission;
  who: string;
  onRoom: (patch: Partial<ManagerRoomSubmission>) => void;
}) {
  const residents = room.occupancyCapacity ?? 1;
  if (residents < 2) return null;

  const leaseValue = room.sharedRoomLeaseKind ?? "property_default";

  return (
    <>
      <FactRow label="Pricing">
        <span className="text-right text-[13.5px] text-foreground">{pricingSummary(room)}</span>
      </FactRow>
      <FactRow label="Lease">
        <FieldSingleSelect
          hideLabel
          label={`Shared room lease for ${who}`}
          variant="cell"
          className="min-w-[180px] max-w-[260px]"
          options={LEASE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={leaseValue}
          onChange={(value) => {
            onRoom({
              sharedRoomLeaseKind: value as ManagerRoomSubmission["sharedRoomLeaseKind"],
            });
          }}
        />
      </FactRow>
      <FactRow label="Application form">
        <span className="text-[13.5px] text-foreground">Property application form</span>
      </FactRow>
      <FactRow label="Lease form">
        <span className="text-[13.5px] text-foreground">Property lease form</span>
      </FactRow>
    </>
  );
}
