"use client";

/**
 * Add / Edit availability — the one popup behind the clock menu, the Day
 * panel, a drag on the grid and a click on a band (C2-CALA2). Right-hand
 * preview is a small week showing exactly the bands Save will create.
 */
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PopupRecordPreview } from "@/components/portal/popup-live-preview";
import { formatAvailabilitySlotLabel } from "@/lib/demo-admin-scheduling";
import {
  ALL_HOUSES,
  AVAILABILITY_KIND_CHOICES,
  isRealDateStr,
  previewWeek,
  storageKindsForChoices,
  toggleExclusiveChoice,
  validateDraft,
  weekdayOfDateStr,
  type AvailabilityDraft,
  type AvailabilityKindChoice,
} from "@/lib/calendar-availability-window";
import { bandKindsLabel, bandPaint, bandStyle } from "@/lib/calendar-grid";
import { cn } from "@/lib/utils";

const WEEKDAYS = [
  { value: "0", label: "Mon" },
  { value: "1", label: "Tue" },
  { value: "2", label: "Wed" },
  { value: "3", label: "Thu" },
  { value: "4", label: "Fri" },
  { value: "5", label: "Sat" },
  { value: "6", label: "Sun" },
];
const WEEKDAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const FROM_OPTIONS = Array.from({ length: 48 }, (_, slot) => ({
  value: String(slot),
  label: formatAvailabilitySlotLabel(slot),
}));
const TO_OPTIONS = Array.from({ length: 48 }, (_, index) => {
  const slot = index + 1;
  return { value: String(slot), label: slot >= 48 ? "12 am" : formatAvailabilitySlotLabel(slot) };
});

/** Ticking the exclusive entry (Everything / All houses) clears the specific picks, and the reverse. */
function applyExclusive(prev: readonly string[], next: readonly string[], exclusive: string): string[] {
  const added = next.find((value) => !prev.includes(value));
  if (added !== undefined) return toggleExclusiveChoice(prev, added, true, exclusive);
  const removed = prev.find((value) => !next.includes(value));
  if (removed !== undefined) return toggleExclusiveChoice(prev, removed, false, exclusive);
  return [...next];
}

function whenLabel(draft: AvailabilityDraft): string {
  if (draft.on === "date") {
    if (!isRealDateStr(draft.date)) return "Pick a date";
    const day = WEEKDAY_LONG[weekdayOfDateStr(draft.date)] ?? "";
    return `${day.slice(0, 3)}, ${draft.date}`;
  }
  const days = [...draft.weekdays].sort((a, b) => a - b).map((day) => WEEKDAYS[day]?.label ?? "");
  const base = days.length > 0 ? days.join(", ") : "Pick a day";
  return `${base} · ${draft.repeat === "week" ? "This week only" : "Every week"}`;
}

function AvailabilityWeekPreview({
  draft,
  propertyLabels,
}: {
  draft: AvailabilityDraft;
  propertyLabels: Map<string, string>;
}) {
  const week = previewWeek(draft);
  const kinds = storageKindsForChoices(draft.kinds);
  const paint = bandPaint(kinds);
  const lo = Math.floor((week.ok ? Math.min(week.startSlot, 16) : 16) / 2) * 2;
  const hi = Math.ceil((week.ok ? Math.max(week.endSlotExclusive, 36) : 36) / 2) * 2;
  const PX = 9; // px per half hour
  const height = (hi - lo) * PX;
  const axis: number[] = [];
  for (let slot = lo; slot < hi; slot += 4) axis.push(slot);
  const houses =
    draft.propertyIds.length === 0 || draft.propertyIds.includes(ALL_HOUSES)
      ? "All houses"
      : draft.propertyIds.map((id) => propertyLabels.get(id) ?? id).join(", ");
  return (
    <div className="space-y-3" data-attr="calendar-availability-preview">
      <div className="rounded-xl border border-border bg-card p-2.5">
        <div className="grid grid-cols-[34px_minmax(0,1fr)] gap-1.5">
          <div className="relative mt-[18px]" style={{ height }}>
            {axis.map((slot) => (
              <span
                key={slot}
                className="absolute right-0 -translate-y-1.5 whitespace-nowrap text-[9.5px] text-muted"
                style={{ top: (slot - lo) * PX }}
              >
                {formatAvailabilitySlotLabel(slot)}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-[3px]">
            {WEEKDAYS.map((day, index) => {
              const on = week.ok && week.weekdays.includes(index);
              return (
                <div key={day.value}>
                  <b className="block h-[18px] text-center text-[10px] font-bold leading-[18px] text-muted">
                    {day.label.charAt(0)}
                  </b>
                  <div
                    className={cn("relative rounded-[5px]", index > 4 ? "bg-foreground/[0.06]" : "bg-foreground/[0.035]")}
                    style={{ height }}
                  >
                    {on ? (
                      <i
                        className="absolute left-0 right-0 rounded-[4px]"
                        data-attr="calendar-availability-preview-band"
                        style={{
                          top: (week.startSlot - lo) * PX,
                          height: (week.endSlotExclusive - week.startSlot) * PX,
                          ...bandStyle(paint, "preview"),
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="text-xs font-semibold text-muted" data-attr="calendar-availability-preview-caption">
        {week.weekOf ? `Week of ${week.weekOf}` : "Every week"}
      </p>
      <PopupRecordPreview
        rows={[
          { label: "For", value: bandKindsLabel(kinds, true) },
          { label: "On", value: whenLabel(draft) },
          {
            label: "Hours",
            value: week.ok
              ? `${formatAvailabilitySlotLabel(draft.startSlot)} – ${draft.endSlotExclusive >= 48 ? "12 am" : formatAvailabilitySlotLabel(draft.endSlotExclusive)}`
              : "End must be after start",
          },
          { label: "Houses", value: houses },
        ]}
      />
    </div>
  );
}

export type CalendarAvailabilityDialogProps = {
  open: boolean;
  onClose: () => void;
  initial: AvailabilityDraft;
  /** Present when a painted band was clicked: the dialog reads "Edit availability" and offers Delete. */
  editing: boolean;
  propertyOptions: ReadonlyArray<{ id: string; label: string }>;
  onSave: (draft: AvailabilityDraft) => void;
  onDelete?: () => void;
};

export function CalendarAvailabilityDialog({
  open,
  onClose,
  initial,
  editing,
  propertyOptions,
  onSave,
  onDelete,
}: CalendarAvailabilityDialogProps) {
  const [draft, setDraft] = useState<AvailabilityDraft>(initial);
  const [seen, setSeen] = useState({ open, initial });
  // Re-seed the form each time the popup opens (or is reopened for another band).
  if (seen.open !== open || (open && seen.initial !== initial)) {
    setSeen({ open, initial });
    if (open) setDraft(initial);
  }
  const patch = (next: Partial<AvailabilityDraft>) => setDraft((prev) => ({ ...prev, ...next }));
  const problem = validateDraft(draft);
  const propertyLabels = useMemo(() => new Map(propertyOptions.map((p) => [p.id, p.label])), [propertyOptions]);

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title={editing ? "Edit availability" : "Add availability"}
      dataAttr="calendar-availability-dialog"
      preview={<AvailabilityWeekPreview draft={draft} propertyLabels={propertyLabels} />}
      previewLabel="AVAILABILITY PREVIEW"
      primaryAction={{
        label: editing ? "Save" : "Add availability",
        disabled: Boolean(problem),
        onClick: () => onSave(draft),
        dataAttr: "calendar-availability-save",
      }}
      secondaryAction={
        editing && onDelete
          ? { label: "Delete", onClick: onDelete, dataAttr: "calendar-availability-delete" }
          : undefined
      }
    >
      <div className="space-y-4">
        <CheckboxMultiSelect
          label="Availability for"
          options={AVAILABILITY_KIND_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
          selected={draft.kinds}
          onChange={(next) =>
            patch({ kinds: applyExclusive(draft.kinds, next, "everything") as AvailabilityKindChoice[] })
          }
          dataAttr="calendar-availability-kinds"
        />
        <FieldSingleSelect
          label="On"
          value={draft.on}
          onChange={(next) => patch({ on: next === "date" ? "date" : "days" })}
          options={[
            { value: "days", label: "Days of the week" },
            { value: "date", label: "A date" },
          ]}
          dataAttr="calendar-availability-on"
        />
        {draft.on === "days" ? (
          <>
            <CheckboxMultiSelect
              label="Days"
              options={WEEKDAYS}
              selected={draft.weekdays.map(String)}
              onChange={(next) =>
                patch({
                  weekdays: next
                    .map((value) => Number.parseInt(value, 10))
                    .filter((value) => Number.isFinite(value))
                    .sort((a, b) => a - b),
                })
              }
              emptyLabel="Pick days"
              dataAttr="calendar-availability-days"
            />
            <FieldSingleSelect
              label="Repeats"
              value={draft.repeat}
              onChange={(next) => patch({ repeat: next === "week" ? "week" : "weekly" })}
              options={[
                { value: "weekly", label: "Every week" },
                { value: "week", label: "This week only" },
              ]}
              dataAttr="calendar-availability-repeat"
            />
          </>
        ) : (
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
            Date
            <Input
              type="date"
              className="mt-1.5 normal-case"
              value={draft.date}
              onChange={(e) => patch({ date: e.target.value })}
              data-attr="calendar-availability-date"
            />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <FieldSingleSelect
            label="From"
            value={String(draft.startSlot)}
            onChange={(next) => {
              const startSlot = Number.parseInt(next, 10);
              if (!Number.isFinite(startSlot)) return;
              patch({
                startSlot,
                endSlotExclusive:
                  draft.endSlotExclusive <= startSlot ? Math.min(48, startSlot + 1) : draft.endSlotExclusive,
              });
            }}
            options={FROM_OPTIONS}
            dataAttr="calendar-availability-from"
          />
          <FieldSingleSelect
            label="To"
            value={String(draft.endSlotExclusive)}
            onChange={(next) => {
              const endSlotExclusive = Number.parseInt(next, 10);
              if (!Number.isFinite(endSlotExclusive)) return;
              patch({ endSlotExclusive });
            }}
            options={TO_OPTIONS}
            dataAttr="calendar-availability-to"
          />
        </div>
        <CheckboxMultiSelect
          label="Properties"
          options={[
            { value: ALL_HOUSES, label: "All houses" },
            ...propertyOptions.map((p) => ({ value: p.id, label: p.label })),
          ]}
          selected={draft.propertyIds}
          onChange={(next) => patch({ propertyIds: applyExclusive(draft.propertyIds, next, ALL_HOUSES) })}
          dataAttr="calendar-availability-properties"
        />
        {problem ? (
          <p className="text-xs font-semibold text-danger" data-attr="calendar-availability-problem">
            {problem}
          </p>
        ) : null}
      </div>
    </PortalDialog>
  );
}
