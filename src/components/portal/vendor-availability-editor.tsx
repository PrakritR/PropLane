"use client";

/**
 * Set availability — redesigned (VD22, 2026-09-27): weekly hours (on/off per
 * day, one or more time windows, + add / × remove, copy-to-every-day,
 * Flexible kept) plus Date overrides (date, all day or hours, note, listed
 * with delete), one Save. This is the one canonical `VendorAvailabilityEditor`
 * (s27/vavail, 2026-09-27 dedupe): the vendor Calendar page's "Set
 * availability" dialog renders it with `dialog`, and vendor Settings ›
 * Availability (vendor-settings-panel.tsx) renders it inline with
 * `dialog={false}` — the settings-local fork that used to live in that file
 * has been deleted so there is only ever this one implementation, one
 * `VENDOR_AVAILABILITY_CHANGED_EVENT` / `VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT`
 * contract, and one `/api/vendor/availability` round trip either surface can
 * trigger.
 *
 * Every edit still round-trips `/api/vendor/availability` immediately
 * (add/remove/toggle), matching how the rest of the app already persists —
 * there is no local-only draft mode. "One Save" (VD22) closes the dialog;
 * in the inline (Settings) placement there is nothing to close, so Save is
 * simply a confirmation.
 */
import { useEffect, useMemo, useState } from "react";
import { Copy, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  WEEKDAY_DISPLAY_ORDER,
  WEEKDAY_LABELS,
  deleteVendorAvailabilityRule,
  fetchVendorAvailability,
  formatMinuteOfDayLabel,
  isFlexibleWeeklyRule,
  minuteOfDayToTimeInputValue,
  saveVendorBlockRule,
  saveVendorDateRule,
  saveVendorWeeklyRule,
  timeInputValueToMinuteOfDay,
  type VendorAvailabilityRule,
} from "@/lib/vendor-availability";

export const VENDOR_AVAILABILITY_CHANGED_EVENT = "axis:vendor-availability-changed";
export const VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT = "axis:vendor-availability-edit-request";

function notifyAvailabilityChanged(rules?: VendorAvailabilityRule[]) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VENDOR_AVAILABILITY_CHANGED_EVENT, { detail: { rules } }));
  }
}

function todayDateInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type WeeklyWindow = Extract<VendorAvailabilityRule, { kind: "weekly" }>;
type OverrideRule = Extract<VendorAvailabilityRule, { kind: "open" | "block" }>;
type OverrideType = "open" | "block";

let demoRuleCounter = 0;

/**
 * Unique id for a demo-only availability rule. The counter is owned by this
 * module function rather than bumped from the component's own handlers —
 * reassigning an outer binding from inside a component is a render-order side
 * effect (`react-hooks/globals`), and these ids never reach the database.
 */
function nextDemoRuleId(prefix: string): string {
  demoRuleCounter += 1;
  return `${prefix}-${demoRuleCounter}`;
}

/** One day's non-flexible weekly windows, sorted. */
function windowsForDay(rules: VendorAvailabilityRule[], weekday: number): WeeklyWindow[] {
  return rules
    .filter((r): r is WeeklyWindow => r.kind === "weekly" && r.weekday === weekday && !isFlexibleWeeklyRule(r))
    .sort((a, b) => a.startMinute - b.startMinute);
}

function flexibleRuleForDay(rules: VendorAvailabilityRule[], weekday: number): WeeklyWindow | undefined {
  return rules.find((r): r is WeeklyWindow => r.kind === "weekly" && r.weekday === weekday && isFlexibleWeeklyRule(r));
}

/** One inline start/end time-window chip — commits on blur, never per keystroke. */
function WindowChip({
  window,
  busy,
  onCommit,
  onRemove,
}: {
  window: WeeklyWindow;
  busy: boolean;
  onCommit: (startMinute: number, endMinute: number) => void;
  onRemove: () => void;
}) {
  const [start, setStart] = useState(minuteOfDayToTimeInputValue(window.startMinute));
  const [end, setEnd] = useState(minuteOfDayToTimeInputValue(window.endMinute));

  useEffect(() => {
    setStart(minuteOfDayToTimeInputValue(window.startMinute));
    setEnd(minuteOfDayToTimeInputValue(window.endMinute));
  }, [window.startMinute, window.endMinute]);

  const commit = () => {
    const s = timeInputValueToMinuteOfDay(start);
    const e = timeInputValueToMinuteOfDay(end);
    if (s === null || e === null || s >= e) {
      setStart(minuteOfDayToTimeInputValue(window.startMinute));
      setEnd(minuteOfDayToTimeInputValue(window.endMinute));
      return;
    }
    if (s !== window.startMinute || e !== window.endMinute) onCommit(s, e);
  };

  return (
    <span
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-1 py-0.5"
      data-attr="vendor-availability-window"
    >
      <input
        type="time"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        onBlur={commit}
        className="w-[96px] border-0 bg-transparent text-[13px] outline-none"
        data-attr="vendor-availability-window-start"
      />
      <span className="text-muted">–</span>
      <input
        type="time"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        onBlur={commit}
        className="w-[96px] border-0 bg-transparent text-[13px] outline-none"
        data-attr="vendor-availability-window-end"
      />
      <button
        type="button"
        aria-label={`Remove ${formatMinuteOfDayLabel(window.startMinute)}–${formatMinuteOfDayLabel(window.endMinute)}`}
        title="Remove window"
        className="inline-flex size-6 items-center justify-center rounded-md text-muted hover:text-danger disabled:opacity-50"
        disabled={busy}
        onClick={onRemove}
        data-attr="vendor-availability-window-remove"
      >
        <X className="size-3.5" strokeWidth={2} aria-hidden />
      </button>
    </span>
  );
}

function DayRow({
  weekday,
  rules,
  busyId,
  onToggleFlexible,
  onToggleEnabled,
  onAddWindow,
  onCommitWindow,
  onRemoveWindow,
  onCopyToEveryDay,
}: {
  weekday: number;
  rules: VendorAvailabilityRule[];
  busyId: string | null;
  onToggleFlexible: () => void;
  onToggleEnabled: () => void;
  onAddWindow: () => void;
  onCommitWindow: (id: string, startMinute: number, endMinute: number) => void;
  onRemoveWindow: (id: string) => void;
  onCopyToEveryDay: () => void;
}) {
  const windows = windowsForDay(rules, weekday);
  const flexible = flexibleRuleForDay(rules, weekday);
  const enabled = flexible !== undefined || windows.length > 0;

  return (
    <div className="grid grid-cols-[86px_1fr_auto] items-center gap-2.5 border-t border-border/60 px-3 py-2.5 first:border-t-0 max-sm:grid-cols-1 max-sm:items-start">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${WEEKDAY_LABELS[weekday]} availability`}
          data-attr={`vendor-availability-toggle-${WEEKDAY_LABELS[weekday].toLowerCase()}`}
          onClick={onToggleEnabled}
          className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition ${
            enabled ? "bg-primary" : "bg-accent"
          }`}
        >
          <span
            className={`inline-block size-4.5 transform rounded-full bg-card shadow transition ${
              enabled ? "translate-x-5" : "translate-x-1"
            }`}
          />
        </button>
        <span className="w-8 text-[12.5px] font-bold uppercase tracking-wide text-foreground">
          {WEEKDAY_LABELS[weekday]}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-attr={`vendor-availability-flexible-${WEEKDAY_LABELS[weekday].toLowerCase()}`}
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 transition ${
            flexible ? "bg-primary/10 text-primary ring-primary/30" : "bg-accent/30 text-muted ring-border hover:text-foreground"
          }`}
          onClick={onToggleFlexible}
        >
          Flexible
        </button>
        {flexible ? (
          <span className="text-xs font-medium text-primary">Any time</span>
        ) : !enabled ? (
          <span className="text-xs text-muted">Unavailable</span>
        ) : (
          <>
            {windows.map((w) => (
              <WindowChip
                key={w.id}
                window={w}
                busy={busyId === w.id}
                onCommit={(s, e) => onCommitWindow(w.id, s, e)}
                onRemove={() => onRemoveWindow(w.id)}
              />
            ))}
            <button
              type="button"
              data-attr="vendor-availability-add-window"
              className="inline-flex items-center gap-1 rounded-lg border border-dashed border-border px-2 py-1 text-[12px] font-semibold text-primary hover:bg-primary/5"
              onClick={onAddWindow}
            >
              <Plus className="size-3.5" strokeWidth={2} aria-hidden />
              Add window
            </button>
          </>
        )}
      </div>

      {enabled && !flexible ? (
        <button
          type="button"
          title="Copy to every day"
          aria-label={`Copy ${WEEKDAY_LABELS[weekday]} to every day`}
          data-attr="vendor-availability-copy-day"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-accent/40 hover:text-foreground"
          onClick={onCopyToEveryDay}
        >
          <Copy className="size-4" strokeWidth={1.8} aria-hidden />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** Weekly hours + date overrides — inline in Settings (`dialog=false`) or the calendar dialog (`dialog=true`). */
export function VendorAvailabilityEditor({ dialog = false }: { dialog?: boolean }) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [rules, setRules] = useState<VendorAvailabilityRule[]>([]);
  const [loaded, setLoaded] = useState(demo);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [overrideDraft, setOverrideDraft] = useState({
    date: todayDateInputValue(),
    type: "open" as OverrideType,
    allDay: true,
    start: "09:00",
    end: "17:00",
    note: "",
  });
  const [addingOverride, setAddingOverride] = useState(false);

  const reload = async () => {
    if (demo) return;
    const next = await fetchVendorAvailability(undefined, { force: true });
    setRules(next);
    setLoaded(true);
    notifyAvailabilityChanged(next);
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const openEditor = (event: Event) => {
      const detail = (event as CustomEvent<{ date?: string; slotIdx?: number }>).detail;
      if (!detail?.date) return;
      const minutes = typeof detail.slotIdx === "number" ? detail.slotIdx * 30 : null;
      setOverrideDraft({
        date: detail.date,
        type: "open",
        allDay: minutes === null,
        start: minutes === null ? "09:00" : minuteOfDayToTimeInputValue(minutes),
        end: minutes === null ? "17:00" : minuteOfDayToTimeInputValue(Math.min(24 * 60, minutes + 30)),
        note: "",
      });
      setAddingOverride(true);
      if (dialog) setDialogOpen(true);
    };
    window.addEventListener(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, openEditor);
    return () => window.removeEventListener(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, openEditor);
  }, [dialog]);

  const overrides = useMemo(
    () =>
      rules
        .filter((r): r is OverrideRule => r.kind === "open" || r.kind === "block")
        .sort((a, b) => a.specificDate.localeCompare(b.specificDate)),
    [rules],
  );

  const applyDemoRules = (next: VendorAvailabilityRule[]) => {
    setRules(next);
    notifyAvailabilityChanged(next);
  };

  const addWindow = async (weekday: number) => {
    const existing = windowsForDay(rules, weekday);
    const start = existing.length ? Math.min(22 * 60, existing[existing.length - 1]!.endMinute) : 9 * 60;
    const end = Math.min(24 * 60, start + 60) > start ? Math.min(24 * 60, start + 60) : 24 * 60;
    if (demo) {
      applyDemoRules([
        ...rules,
        { id: nextDemoRuleId("demo-avail"), kind: "weekly", weekday, startMinute: start, endMinute: end },
      ]);
      return;
    }
    const result = await saveVendorWeeklyRule({ weekday, startMinute: start, endMinute: end });
    if (!result.ok) {
      showToast(result.error ?? "Could not add that window.");
      return;
    }
    await reload();
  };

  const commitWindow = async (id: string, weekday: number, startMinute: number, endMinute: number) => {
    if (demo) {
      applyDemoRules(rules.map((r) => (r.id === id ? { ...r, startMinute, endMinute } : r)));
      return;
    }
    setBusyId(id);
    const result = await saveVendorWeeklyRule({ id, weekday, startMinute, endMinute });
    setBusyId(null);
    if (!result.ok) {
      showToast(result.error ?? "Could not save that window.");
      return;
    }
    await reload();
  };

  const removeRule = async (id: string) => {
    if (demo) {
      applyDemoRules(rules.filter((r) => r.id !== id));
      return;
    }
    setBusyId(id);
    const result = await deleteVendorAvailabilityRule(id);
    setBusyId(null);
    if (!result.ok) {
      showToast(result.error ?? "Could not remove that.");
      return;
    }
    await reload();
  };

  const toggleEnabled = async (weekday: number) => {
    const windows = windowsForDay(rules, weekday);
    const flexible = flexibleRuleForDay(rules, weekday);
    if (windows.length === 0 && !flexible) {
      await addWindow(weekday);
      return;
    }
    // Turning a day off clears its persisted windows/flexible flag — the
    // real availability model has no separate "enabled but remembered"
    // state, only actual rules.
    for (const w of windows) await removeRule(w.id);
    if (flexible) await removeRule(flexible.id);
  };

  const toggleFlexible = async (weekday: number) => {
    const existing = flexibleRuleForDay(rules, weekday);
    if (existing) {
      await removeRule(existing.id);
      return;
    }
    if (demo) {
      applyDemoRules([
        ...rules,
        { id: nextDemoRuleId("demo-avail-flex"), kind: "weekly", weekday, startMinute: 0, endMinute: 1440, note: "Flexible" },
      ]);
      showToast("Marked flexible. Managers can schedule any time this day.");
      return;
    }
    const result = await saveVendorWeeklyRule({ weekday, startMinute: 0, endMinute: 1440, note: "Flexible" });
    if (!result.ok) {
      showToast(result.error ?? "Could not save flexible schedule.");
      return;
    }
    showToast("Marked flexible. Managers can schedule any time this day.");
    await reload();
  };

  const copyToEveryDay = async (sourceWeekday: number) => {
    const sourceWindows = windowsForDay(rules, sourceWeekday);
    if (!sourceWindows.length) return;
    for (const weekday of WEEKDAY_DISPLAY_ORDER) {
      if (weekday === sourceWeekday) continue;
      for (const w of windowsForDay(rules, weekday)) await removeRule(w.id);
      const flex = flexibleRuleForDay(rules, weekday);
      if (flex) await removeRule(flex.id);
      for (const w of sourceWindows) {
        if (demo) {
          applyDemoRules([
            ...rules,
            { id: nextDemoRuleId("demo-avail"), kind: "weekly", weekday, startMinute: w.startMinute, endMinute: w.endMinute },
          ]);
        } else {
          await saveVendorWeeklyRule({ weekday, startMinute: w.startMinute, endMinute: w.endMinute });
        }
      }
    }
    if (!demo) await reload();
    showToast(`Copied ${WEEKDAY_LABELS[sourceWeekday]} to every day.`);
  };

  const addOverride = async () => {
    if (!overrideDraft.date) {
      showToast("Choose a date first.");
      return;
    }
    let startMinute: number | undefined;
    let endMinute: number | undefined;
    if (!overrideDraft.allDay) {
      const s = timeInputValueToMinuteOfDay(overrideDraft.start);
      const e = timeInputValueToMinuteOfDay(overrideDraft.end);
      if (s === null || e === null || s >= e) {
        showToast("Choose a valid start and end time, or mark it all day.");
        return;
      }
      startMinute = s;
      endMinute = e;
    }
    if (demo) {
      applyDemoRules([
        ...rules,
        {
          id: nextDemoRuleId("demo-avail-override"),
          kind: overrideDraft.type,
          specificDate: overrideDraft.date,
          startMinute: startMinute ?? 0,
          endMinute: endMinute ?? 1440,
          note: overrideDraft.note || null,
        },
      ]);
      setAddingOverride(false);
      if (dialog) setDialogOpen(false);
      showToast("Date added.");
      return;
    }
    const save = overrideDraft.type === "open" ? saveVendorDateRule : saveVendorBlockRule;
    const result = await save({ specificDate: overrideDraft.date, startMinute, endMinute, note: overrideDraft.note });
    if (!result.ok) {
      showToast(result.error ?? "Could not save that date.");
      return;
    }
    setAddingOverride(false);
    if (dialog) setDialogOpen(false);
    showToast("Date added.");
    await reload();
  };

  const editor = (
    <div className="space-y-4" data-attr="vw-avail">
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border bg-accent/20 px-3.5 py-2.5">
          <span className="text-[13px] font-bold">Weekly hours</span>
        </div>
        {WEEKDAY_DISPLAY_ORDER.map((weekday) => (
          <DayRow
            key={weekday}
            weekday={weekday}
            rules={rules}
            busyId={busyId}
            onToggleFlexible={() => void toggleFlexible(weekday)}
            onToggleEnabled={() => void toggleEnabled(weekday)}
            onAddWindow={() => void addWindow(weekday)}
            onCommitWindow={(id, s, e) => void commitWindow(id, weekday, s, e)}
            onRemoveWindow={(id) => void removeRule(id)}
            onCopyToEveryDay={() => void copyToEveryDay(weekday)}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border bg-accent/20 px-3.5 py-2.5">
          <span className="text-[13px] font-bold">Date overrides</span>
          <Button
            type="button"
            variant="outline"
            data-attr="vendor-availability-add-override"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => setAddingOverride((v) => !v)}
          >
            {addingOverride ? "Cancel" : "+ Add date"}
          </Button>
        </div>

        {addingOverride ? (
          <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-border/60 p-3.5">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
              Date
              <Input
                type="date"
                value={overrideDraft.date}
                onChange={(e) => setOverrideDraft((d) => ({ ...d, date: e.target.value }))}
                className="h-9 w-[160px] rounded-md text-sm"
                data-attr="vendor-availability-override-date"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
              Type
              <Select
                value={overrideDraft.type}
                onChange={(e) => setOverrideDraft((d) => ({ ...d, type: e.target.value as OverrideType }))}
                className="h-9 min-w-[150px] rounded-md text-sm"
                data-attr="vendor-availability-override-type"
              >
                <option value="open">Open extra time</option>
                <option value="block">Block time off</option>
              </Select>
            </label>
            <label className="flex items-center gap-2 pb-1.5 text-xs font-medium text-muted">
              <input
                type="checkbox"
                checked={overrideDraft.allDay}
                onChange={(e) => setOverrideDraft((d) => ({ ...d, allDay: e.target.checked }))}
                className="h-4 w-4 rounded border-border"
                data-attr="vendor-availability-override-allday"
              />
              All day
            </label>
            {!overrideDraft.allDay ? (
              <>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  Start
                  <Input
                    type="time"
                    value={overrideDraft.start}
                    onChange={(e) => setOverrideDraft((d) => ({ ...d, start: e.target.value }))}
                    className="h-9 w-[120px] rounded-md text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  End
                  <Input
                    type="time"
                    value={overrideDraft.end}
                    onChange={(e) => setOverrideDraft((d) => ({ ...d, end: e.target.value }))}
                    className="h-9 w-[120px] rounded-md text-sm"
                  />
                </label>
              </>
            ) : null}
            <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-[11px] font-medium text-muted">
              Note (optional)
              <Input
                type="text"
                placeholder="e.g. Saturday availability"
                value={overrideDraft.note}
                onChange={(e) => setOverrideDraft((d) => ({ ...d, note: e.target.value }))}
                className="h-9 rounded-md text-sm"
              />
            </label>
            <Button
              type="button"
              variant="primary"
              data-attr="vendor-availability-save-override"
              className="h-9 rounded-full px-4 text-sm"
              disabled={!loaded}
              onClick={() => void addOverride()}
            >
              Save
            </Button>
          </div>
        ) : null}

        {overrides.length === 0 ? (
          <p className="px-3.5 py-4 text-center text-xs text-muted">No specific dates added</p>
        ) : (
          overrides.map((o) => (
            <div
              key={o.id}
              className="flex items-center justify-between gap-2 border-t border-border/60 px-3.5 py-2.5 first:border-t-0"
              data-attr="vendor-availability-override-row"
            >
              <div>
                <p className="text-[13.5px] font-semibold text-foreground">
                  {new Date(`${o.specificDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  {" · "}
                  {o.startMinute === 0 && o.endMinute === 1440
                    ? "All day"
                    : `${formatMinuteOfDayLabel(o.startMinute)}–${formatMinuteOfDayLabel(o.endMinute)}`}
                  {" · "}
                  <span className={o.kind === "block" ? "text-danger" : "text-primary"}>
                    {o.kind === "block" ? "Blocked" : "Open"}
                  </span>
                </p>
                {o.note ? <p className="mt-0.5 text-xs text-muted">{o.note}</p> : null}
              </div>
              <button
                type="button"
                aria-label={`Remove ${o.specificDate}`}
                title="Remove"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                disabled={busyId === o.id}
                onClick={() => void removeRule(o.id)}
                data-attr="vendor-availability-override-remove"
              >
                <X className="size-4" strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          ))
        )}
      </div>

      {!loaded ? <p className="text-xs text-muted">Loading availability…</p> : null}

      {/* Weekly-hours edits already auto-commit on toggle/blur — this Save
          is the one bottom action VD22 asks for: it also submits a pending
          date-override draft (its own "Save" button above does the same,
          so there is only ever one visibly-named Save control at a time). */}
      {dialog && !addingOverride ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="primary"
            data-attr="vendor-availability-save"
            onClick={() => {
              setDialogOpen(false);
              showToast("Availability saved.");
            }}
          >
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );

  if (!dialog) return editor;

  return (
    <Modal
      open={dialogOpen}
      onClose={() => setDialogOpen(false)}
      title="Set availability"
      panelClassName="w-full max-w-2xl"
      dataAttr="vendor-calendar-availability-dialog"
    >
      {editor}
    </Modal>
  );
}
