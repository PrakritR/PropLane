"use client";

import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { entireHomeMonthlyRentAmount } from "@/lib/manager-listing-submission";

function money(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

/** Rooms, then the whole house, with the price each one charges. */
export function PropertyPricingPanel({ submission }: { submission: ManagerListingSubmissionV1 }) {
  const rooms = submission.rooms.filter((room) => room.name.trim() || room.monthlyRent > 0);
  const whole = entireHomeMonthlyRentAmount(submission);
  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-card" data-attr="property-pricing">
      {rooms.map((room) => (
        <div key={room.id} className="flex items-center gap-3 px-4 py-3" data-attr="property-pricing-room">
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">
            {room.name.trim() || "Room"}
          </span>
          <span className="shrink-0 text-[14px] font-semibold tabular-nums text-foreground">
            {room.monthlyRent > 0 ? `${money(room.monthlyRent)}/mo` : "—"}
          </span>
        </div>
      ))}
      <div className="flex items-center gap-3 px-4 py-3" data-attr="property-pricing-whole">
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">Whole house</span>
        <span className="shrink-0 text-[14px] font-semibold tabular-nums text-foreground">
          {whole > 0 ? `${money(whole)}/mo` : "—"}
        </span>
      </div>
    </div>
  );
}
