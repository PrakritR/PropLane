"use client";

import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import type { ManagerRoomSubmission } from "@/lib/manager-listing-submission";
import { FactRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";

const PRICING_OPTIONS = [
  { value: "per_bed", label: "Per bed" },
  { value: "whole_room", label: "Whole room split evenly" },
] as const;

const LEASE_OPTIONS = [
  { value: "property_default", label: "Property default" },
  { value: "individual", label: "One lease per resident" },
  { value: "joint", label: "One joint lease for roommates" },
] as const;

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

  const pricingValue = room.residentPricing === "per_resident" ? "per_bed" : "whole_room";
  const leaseValue = room.sharedRoomLeaseKind ?? "property_default";

  return (
    <>
      <FactRow label="Pricing">
        <FieldSingleSelect
          hideLabel
          label={`Shared room pricing for ${who}`}
          variant="cell"
          className="min-w-[180px] max-w-[260px]"
          options={PRICING_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={pricingValue}
          onChange={(value) => {
            onRoom({
              residentPricing: value === "per_bed" ? "per_resident" : "same",
            });
          }}
        />
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
