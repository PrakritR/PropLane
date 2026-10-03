"use client";

/**
 * Bed pick for a shared room (PLAN-0924-0718). One radio row per slot —
 * "Bed N · $rent/mo" with the SAME rent for every resident (never split).
 * Taken rows show availability only; a bed never identifies its resident.
 *
 * Pure presentation over `openResidentSlots` — this component never decides
 * openness itself, so the picker and the write it feeds are always reading
 * the same answer.
 */
import type { OpenResidentSlot } from "@/lib/rental-application/room-occupancy";
import { formatRoomPriceAmount } from "@/lib/room-pricing";

export type ApplicationResidentSlotPickerProps = {
  /** From `openResidentSlots` — one entry per slot, ordered. */
  slots: OpenResidentSlot[];
  /** The currently selected slot, or null when nothing is picked yet. */
  value: number | null;
  onChange: (slot: number) => void;
  disabled?: boolean;
  name?: string;
};

/** The lowest OPEN slot, or the first slot when every one is taken — the picker's own default. */
export function defaultOpenResidentSlot(slots: OpenResidentSlot[]): number | null {
  const firstOpen = slots.find((slot) => !slot.holder);
  return firstOpen?.slot ?? slots[0]?.slot ?? null;
}

export function ApplicationResidentSlotPicker({
  slots,
  value,
  onChange,
  disabled = false,
  name = "application-resident-slot",
}: ApplicationResidentSlotPickerProps) {
  if (slots.length === 0) return null;

  return (
    <fieldset className="space-y-2" data-attr="application-resident-slot-picker">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Bed in this room
      </legend>
      {slots.map((slot) => {
        const taken = slot.holder != null;
        const checked = value === slot.slot;
        const rentLabel = slot.price.monthlyRent > 0
          ? `${formatRoomPriceAmount(slot.price.monthlyRent)}/mo`
          : "Rent TBD";
        return (
          <label
            key={slot.slot}
            className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 py-2.5 ${
              taken
                ? "cursor-not-allowed border-border bg-accent/20 text-muted"
                : `cursor-pointer bg-card ${checked ? "border-primary" : "border-border"}`
            }`}
          >
            <input
              type="radio"
              name={name}
              className="h-4 w-4 shrink-0"
              checked={checked}
              disabled={disabled || taken}
              onChange={() => onChange(slot.slot)}
              data-attr={`application-resident-slot-${slot.slot}`}
            />
            <span className="min-w-0 flex-1 text-sm">
              <span className={taken ? "font-semibold" : "font-semibold text-foreground"}>
                Bed {String.fromCharCode(64 + slot.slot)} · {rentLabel}
              </span>
              {slot.price.utilitiesEstimate ? (
                <span className="text-muted"> · +${slot.price.utilitiesEstimate} utilities</span>
              ) : null}
              {slot.price.securityDeposit ? (
                <span className="text-muted"> · ${slot.price.securityDeposit} deposit</span>
              ) : null}
            </span>
            <span className={`shrink-0 text-xs font-semibold ${taken ? "text-muted" : "text-emerald-600"}`}>
              {taken ? "Occupied" : "Open"}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
