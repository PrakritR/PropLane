"use client";

import { useEffect, useMemo, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  fetchOpenTourSlotsForProperty,
  type SlotHosts,
} from "@/lib/schedule-tour-simple";
import {
  buildRescheduleDayOptions,
  buildRescheduleTimeOptions,
  formatRescheduleWhenLabel,
  rescheduleSlotKeyToStartIso,
  type RescheduleDayOption,
  type RescheduleTimeOption,
} from "@/lib/tour-reschedule-slot-picker";
import type { ManagerTourRow } from "@/lib/manager-tour-list";

function tourDurationMinutes(row: ManagerTourRow): number {
  const ms = Date.parse(row.endIso) - Date.parse(row.startIso);
  return Number.isFinite(ms) && ms > 0 ? Math.max(30, Math.round(ms / 60000)) : 30;
}

export function TourRescheduleTimePickerFields({
  row,
  slotKey,
  onSlotKeyChange,
}: {
  row: ManagerTourRow;
  slotKey: string | null;
  onSlotKeyChange: (next: string | null) => void;
}) {
  const [slotHosts, setSlotHosts] = useState<SlotHosts>({});
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const [dayYmd, setDayYmd] = useState(() => row.startIso.slice(0, 10));

  useEffect(() => {
    const propertyId = row.propertyId?.trim();
    if (!propertyId) {
      setSlotHosts({});
      setLoadState("idle");
      return;
    }
    let cancelled = false;
    const listing = getPropertyById(propertyId);
    setLoadState("loading");
    void fetchOpenTourSlotsForProperty({
      id: propertyId,
      buildingName: listing?.buildingName,
      address: listing?.address,
    }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setSlotHosts({});
        setLoadState("error");
        return;
      }
      setSlotHosts(result.slotHosts);
      setLoadState("idle");
    });
    return () => {
      cancelled = true;
    };
  }, [row.propertyId]);

  const dayOptions: RescheduleDayOption[] = useMemo(
    () => buildRescheduleDayOptions({ slotHosts, currentStartIso: row.startIso }),
    [slotHosts, row.startIso],
  );

  useEffect(() => {
    if (dayOptions.some((o) => o.value === dayYmd && !o.disabled)) return;
    const firstOpen = dayOptions.find((o) => !o.disabled);
    if (firstOpen) setDayYmd(firstOpen.value);
  }, [dayOptions, dayYmd]);

  const duration = tourDurationMinutes(row);
  const { options: timeOptions, selectedSlotKey } = useMemo(
    () =>
      buildRescheduleTimeOptions({
        slotHosts,
        dayYmd,
        currentStartIso: row.startIso,
        durationMinutes: duration,
        preferredSlotKey: slotKey,
      }),
    [slotHosts, dayYmd, row.startIso, duration, slotKey],
  );

  useEffect(() => {
    if (selectedSlotKey && selectedSlotKey !== slotKey) onSlotKeyChange(selectedSlotKey);
  }, [selectedSlotKey, slotKey, onSlotKeyChange]);

  const pickedIso = slotKey ? rescheduleSlotKeyToStartIso(slotKey) : null;
  const newLabel = pickedIso ? formatRescheduleWhenLabel(pickedIso, duration) : "No open times that day";
  const currentLabel = formatRescheduleWhenLabel(row.startIso, duration);

  if (!row.propertyId) {
    return <p className="text-sm text-muted">This tour has no property — pick a time from Tours.</p>;
  }
  if (loadState === "loading") {
    return <p className="text-sm text-muted">Loading open times…</p>;
  }
  if (loadState === "error") {
    return <p className="text-sm text-muted">Could not load open tour times.</p>;
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-accent/20 p-3" data-attr="tour-reschedule-picker">
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldSingleSelect
          label="Day"
          value={dayYmd}
          onChange={(next) => {
            setDayYmd(next);
            onSlotKeyChange(null);
          }}
          options={dayOptions.map((opt) => ({ value: opt.value, label: opt.label, disabled: opt.disabled }))}
          dataAttr="tour-reschedule-day"
        />
        <FieldSingleSelect
          label="Time"
          value={slotKey ?? ""}
          disabled={timeOptions.length === 0}
          onChange={(next) => onSlotKeyChange(next || null)}
          options={timeOptions.map((opt: RescheduleTimeOption) => ({ value: opt.slotKey, label: opt.label }))}
          placeholder="No open times"
          dataAttr="tour-reschedule-time"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-muted">Current</span>
          <span className="font-semibold text-foreground line-through decoration-muted/80">{currentLabel}</span>
        </div>
        <span className="text-muted" aria-hidden>
          →
        </span>
        <div className="flex flex-col gap-0.5" data-attr="tour-reschedule-new">
          <span className="font-semibold text-muted">New</span>
          <span className="font-semibold text-foreground">{newLabel}</span>
        </div>
      </div>
    </div>
  );
}
