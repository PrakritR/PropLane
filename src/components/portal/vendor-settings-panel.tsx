"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import {
  PortalSettingsFormBody,
  PortalSettingsGroup,
  PortalSettingsSection,
  PortalSettingsSections,
} from "@/components/portal/portal-settings-ui";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalBugFeedbackPanel } from "@/components/portal/portal-bug-feedback-panel";
import { PortalSettingsExtras } from "@/components/portal/portal-settings-extras";
import { PortalTextNotificationsBlock } from "@/components/portal/portal-text-notifications-block";
import { AssistantCustomInstructionsSetting } from "@/components/portal/assistant-custom-instructions-setting";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { DEMO_VENDOR_EMAIL, DEMO_VENDOR_NAME, isDemoModeActive } from "@/lib/demo/demo-session";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import {
  WEEKDAY_DISPLAY_ORDER,
  WEEKDAY_LABELS,
  deleteVendorAvailabilityRule,
  fetchVendorAvailability,
  formatMinuteOfDayLabel,
  minuteOfDayToTimeInputValue,
  saveVendorBlockRule,
  saveVendorDateRule,
  saveVendorWeeklyRule,
  timeInputValueToMinuteOfDay,
  isFlexibleWeeklyRule,
  type VendorAvailabilityRule,
} from "@/lib/vendor-availability";

/** Tap target for the small chip/row "remove" glyphs — keeps the glyph small while meeting the 44px minimum. */
const AVAILABILITY_REMOVE_BTN =
  "inline-flex min-h-[44px] min-w-[44px] items-center justify-center text-muted hover:text-danger disabled:opacity-50";
/** Text affordance to edit a rule in place instead of delete + re-add. */
const AVAILABILITY_EDIT_BTN = "font-medium text-foreground underline-offset-2 hover:underline";

function minuteRangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

type VendorProfileDraft = {
  name: string;
  phone: string;
  email: string;
  preferredLanguage: string;
  smsConsent: boolean;
};

const EMPTY_PROFILE: VendorProfileDraft = {
  name: "",
  phone: "",
  email: "",
  preferredLanguage: "",
  smsConsent: false,
};

type VendorProfileApiRow = {
  name?: string;
  phone?: string;
  email?: string;
  trades?: string[];
  trade?: string;
  preferredLanguage?: string;
};

const DEMO_VENDOR_PROFILE: VendorProfileDraft = {
  name: DEMO_VENDOR_NAME,
  phone: "(206) 555-0142",
  email: DEMO_VENDOR_EMAIL,
  preferredLanguage: "en",
  smsConsent: true,
};
const DEMO_VENDOR_TRADES = ["HVAC", "Appliance repair"];

function todayDateInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let demoAvailabilityRuleCounter = 0;

export const VENDOR_AVAILABILITY_CHANGED_EVENT = "axis:vendor-availability-changed";

function notifyAvailabilityChanged(rules?: VendorAvailabilityRule[]) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VENDOR_AVAILABILITY_CHANGED_EVENT, { detail: { rules } }));
  }
}

/** Weekly recurring hours + one-off blocked dates, editable inline. */
export function VendorAvailabilityEditor() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [rules, setRules] = useState<VendorAvailabilityRule[]>([]);
  const [loaded, setLoaded] = useState(demo);
  const [weeklyFormOpen, setWeeklyFormOpen] = useState(false);
  const [weeklyDraft, setWeeklyDraft] = useState({ weekday: 1, start: "09:00", end: "17:00" });
  const [weeklyEditingId, setWeeklyEditingId] = useState<string | null>(null);
  const [openFormOpen, setOpenFormOpen] = useState(false);
  const [openDraft, setOpenDraft] = useState({ date: todayDateInputValue(), allDay: true, start: "09:00", end: "17:00", note: "" });
  const [openEditingId, setOpenEditingId] = useState<string | null>(null);
  const [blockFormOpen, setBlockFormOpen] = useState(false);
  const [blockDraft, setBlockDraft] = useState({ date: todayDateInputValue(), allDay: true, start: "09:00", end: "17:00", note: "" });
  const [blockEditingId, setBlockEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    if (demo) return;
    const next = await fetchVendorAvailability();
    setRules(next);
    setLoaded(true);
    notifyAvailabilityChanged();
  };

  useEffect(() => {
    void reload();
  }, []);

  const weeklyByDay = useMemo(() => {
    const map = new Map<number, VendorAvailabilityRule[]>();
    for (const rule of rules) {
      if (rule.kind !== "weekly") continue;
      const list = map.get(rule.weekday) ?? [];
      list.push(rule);
      map.set(rule.weekday, list);
    }
    for (const list of map.values()) list.sort((a, b) => (a.kind === "weekly" && b.kind === "weekly" ? a.startMinute - b.startMinute : 0));
    return map;
  }, [rules]);

  const blocks = useMemo(
    () =>
      rules
        .filter((r): r is Extract<VendorAvailabilityRule, { kind: "block" }> => r.kind === "block")
        .sort((a, b) => a.specificDate.localeCompare(b.specificDate)),
    [rules],
  );

  const opens = useMemo(
    () =>
      rules
        .filter((r): r is Extract<VendorAvailabilityRule, { kind: "open" }> => r.kind === "open")
        .sort((a, b) => a.specificDate.localeCompare(b.specificDate)),
    [rules],
  );

  const resetWeeklyForm = () => {
    setWeeklyEditingId(null);
    setWeeklyDraft({ weekday: 1, start: "09:00", end: "17:00" });
  };

  const startEditWeekly = (rule: Extract<VendorAvailabilityRule, { kind: "weekly" }>) => {
    setWeeklyDraft({
      weekday: rule.weekday,
      start: minuteOfDayToTimeInputValue(rule.startMinute),
      end: minuteOfDayToTimeInputValue(rule.endMinute),
    });
    setWeeklyEditingId(rule.id);
    setWeeklyFormOpen(true);
  };

  const addWeeklyWindow = async () => {
    const start = timeInputValueToMinuteOfDay(weeklyDraft.start);
    const end = timeInputValueToMinuteOfDay(weeklyDraft.end);
    if (start === null || end === null || start >= end) {
      showToast("Choose a valid start and end time.");
      return;
    }
    const overlaps = rules.some(
      (r) =>
        r.kind === "weekly" &&
        r.weekday === weeklyDraft.weekday &&
        r.id !== weeklyEditingId &&
        minuteRangesOverlap(start, end, r.startMinute, r.endMinute),
    );
    if (overlaps) {
      showToast("That overlaps with an existing window on this day.");
      return;
    }
    const editingId = weeklyEditingId;
    if (demo) {
      const next = editingId
        ? rules.map((r) => (r.id === editingId ? { ...r, weekday: weeklyDraft.weekday, startMinute: start, endMinute: end } : r))
        : [
            ...rules,
            {
              id: `demo-avail-new-${++demoAvailabilityRuleCounter}`,
              kind: "weekly" as const,
              weekday: weeklyDraft.weekday,
              startMinute: start,
              endMinute: end,
            },
          ];
      setRules(next);
      notifyAvailabilityChanged(next);
      setWeeklyFormOpen(false);
      resetWeeklyForm();
      showToast(editingId ? "Weekly window updated." : "Weekly window added.");
      return;
    }
    setSaving(true);
    const result = await saveVendorWeeklyRule({ id: editingId ?? undefined, weekday: weeklyDraft.weekday, startMinute: start, endMinute: end });
    setSaving(false);
    if (!result.ok) {
      showToast(result.error ?? "Could not save that window.");
      return;
    }
    setWeeklyFormOpen(false);
    resetWeeklyForm();
    showToast(editingId ? "Weekly window updated." : "Weekly window added.");
    await reload();
  };

  const resetBlockForm = () => {
    setBlockEditingId(null);
    setBlockDraft({ date: todayDateInputValue(), allDay: true, start: "09:00", end: "17:00", note: "" });
  };

  const startEditBlock = (rule: Extract<VendorAvailabilityRule, { kind: "block" }>) => {
    const allDay = rule.startMinute === 0 && rule.endMinute === 1440;
    setBlockDraft({
      date: rule.specificDate,
      allDay,
      start: allDay ? "09:00" : minuteOfDayToTimeInputValue(rule.startMinute),
      end: allDay ? "17:00" : minuteOfDayToTimeInputValue(rule.endMinute),
      note: rule.note ?? "",
    });
    setBlockEditingId(rule.id);
    setBlockFormOpen(true);
  };

  const addBlock = async () => {
    if (!blockDraft.date) {
      showToast("Choose a date to block.");
      return;
    }
    let startMinute: number | undefined;
    let endMinute: number | undefined;
    if (!blockDraft.allDay) {
      const start = timeInputValueToMinuteOfDay(blockDraft.start);
      const end = timeInputValueToMinuteOfDay(blockDraft.end);
      if (start === null || end === null || start >= end) {
        showToast("Choose a valid start and end time, or mark it all day.");
        return;
      }
      startMinute = start;
      endMinute = end;
    }
    const rangeStart = startMinute ?? 0;
    const rangeEnd = endMinute ?? 1440;
    const overlaps = rules.some(
      (r) =>
        r.kind === "block" &&
        r.specificDate === blockDraft.date &&
        r.id !== blockEditingId &&
        minuteRangesOverlap(rangeStart, rangeEnd, r.startMinute, r.endMinute),
    );
    if (overlaps) {
      showToast("That overlaps with an existing blocked window on this date.");
      return;
    }
    const editingId = blockEditingId;
    if (demo) {
      if (editingId) {
        setRules((cur) =>
          cur.map((r) =>
            r.id === editingId
              ? { ...r, specificDate: blockDraft.date, startMinute: rangeStart, endMinute: rangeEnd, note: blockDraft.note || null }
              : r,
          ),
        );
      } else {
        demoAvailabilityRuleCounter += 1;
        setRules((cur) => [
          ...cur,
          {
            id: `demo-avail-new-${demoAvailabilityRuleCounter}`,
            kind: "block",
            specificDate: blockDraft.date,
            startMinute: rangeStart,
            endMinute: rangeEnd,
            note: blockDraft.note || null,
          },
        ]);
      }
      setBlockFormOpen(false);
      resetBlockForm();
      showToast(editingId ? "Blocked date updated." : "Date blocked.");
      return;
    }
    setSaving(true);
    const result = await saveVendorBlockRule({
      id: editingId ?? undefined,
      specificDate: blockDraft.date,
      startMinute,
      endMinute,
      note: blockDraft.note,
    });
    setSaving(false);
    if (!result.ok) {
      showToast(result.error ?? "Could not block that date.");
      return;
    }
    setBlockFormOpen(false);
    resetBlockForm();
    showToast(editingId ? "Blocked date updated." : "Date blocked.");
    await reload();
  };

  const resetOpenForm = () => {
    setOpenEditingId(null);
    setOpenDraft({ date: todayDateInputValue(), allDay: true, start: "09:00", end: "17:00", note: "" });
  };

  const startEditOpen = (rule: Extract<VendorAvailabilityRule, { kind: "open" }>) => {
    const allDay = rule.startMinute === 0 && rule.endMinute === 1440;
    setOpenDraft({
      date: rule.specificDate,
      allDay,
      start: allDay ? "09:00" : minuteOfDayToTimeInputValue(rule.startMinute),
      end: allDay ? "17:00" : minuteOfDayToTimeInputValue(rule.endMinute),
      note: rule.note ?? "",
    });
    setOpenEditingId(rule.id);
    setOpenFormOpen(true);
  };

  const addOpenDate = async () => {
    if (!openDraft.date) {
      showToast("Choose a date to open.");
      return;
    }
    let startMinute: number | undefined;
    let endMinute: number | undefined;
    if (!openDraft.allDay) {
      const start = timeInputValueToMinuteOfDay(openDraft.start);
      const end = timeInputValueToMinuteOfDay(openDraft.end);
      if (start === null || end === null || start >= end) {
        showToast("Choose a valid start and end time, or mark it all day.");
        return;
      }
      startMinute = start;
      endMinute = end;
    }
    const rangeStart = startMinute ?? 0;
    const rangeEnd = endMinute ?? 1440;
    const overlaps = rules.some(
      (r) =>
        r.kind === "open" &&
        r.specificDate === openDraft.date &&
        r.id !== openEditingId &&
        minuteRangesOverlap(rangeStart, rangeEnd, r.startMinute, r.endMinute),
    );
    if (overlaps) {
      showToast("That overlaps with an existing open window on this date.");
      return;
    }
    const editingId = openEditingId;
    if (demo) {
      if (editingId) {
        setRules((cur) =>
          cur.map((r) =>
            r.id === editingId
              ? { ...r, specificDate: openDraft.date, startMinute: rangeStart, endMinute: rangeEnd, note: openDraft.note || null }
              : r,
          ),
        );
      } else {
        demoAvailabilityRuleCounter += 1;
        setRules((cur) => [
          ...cur,
          {
            id: `demo-avail-new-${demoAvailabilityRuleCounter}`,
            kind: "open",
            specificDate: openDraft.date,
            startMinute: rangeStart,
            endMinute: rangeEnd,
            note: openDraft.note || null,
          },
        ]);
      }
      setOpenFormOpen(false);
      resetOpenForm();
      showToast(editingId ? "Open date updated." : "Date opened.");
      return;
    }
    setSaving(true);
    const result = await saveVendorDateRule({
      id: editingId ?? undefined,
      specificDate: openDraft.date,
      startMinute,
      endMinute,
      note: openDraft.note,
    });
    setSaving(false);
    if (!result.ok) {
      showToast(result.error ?? "Could not open that date.");
      return;
    }
    setOpenFormOpen(false);
    resetOpenForm();
    showToast(editingId ? "Open date updated." : "Date opened.");
    await reload();
  };

  const removeRule = async (id: string) => {
    if (weeklyEditingId === id) { setWeeklyFormOpen(false); resetWeeklyForm(); }
    if (openEditingId === id) { setOpenFormOpen(false); resetOpenForm(); }
    if (blockEditingId === id) { setBlockFormOpen(false); resetBlockForm(); }
    if (demo) {
      const next = rules.filter((r) => r.id !== id);
      setRules(next);
      notifyAvailabilityChanged(next);
      return;
    }
    setBusyId(id);
    const ok = await deleteVendorAvailabilityRule(id);
    setBusyId(null);
    if (!ok.ok) {
      showToast(ok.error ?? "Could not remove that.");
      return;
    }
    await reload();
  };

  const flexibleRuleForDay = (weekday: number) =>
    rules.find((r) => r.kind === "weekly" && r.weekday === weekday && isFlexibleWeeklyRule(r));

  const toggleFlexibleDay = async (weekday: number) => {
    const existing = flexibleRuleForDay(weekday);
    if (existing) {
      await removeRule(existing.id);
      showToast("Flexible schedule removed.");
      return;
    }
    if (demo) {
      const next = [
        ...rules.filter((r) => !(r.kind === "weekly" && r.weekday === weekday && isFlexibleWeeklyRule(r))),
        {
          id: `demo-avail-flex-${++demoAvailabilityRuleCounter}`,
          kind: "weekly" as const,
          weekday,
          startMinute: 0,
          endMinute: 1440,
          note: "Flexible",
        },
      ];
      setRules(next);
      notifyAvailabilityChanged(next);
      showToast("Marked flexible. Managers can schedule any time this day.");
      return;
    }
    setSaving(true);
    const result = await saveVendorWeeklyRule({
      weekday,
      startMinute: 0,
      endMinute: 1440,
      note: "Flexible",
    });
    setSaving(false);
    if (!result.ok) {
      showToast(result.error ?? "Could not save flexible schedule.");
      return;
    }
    showToast("Marked flexible. Managers can schedule any time this day.");
    await reload();
  };

  return (
    <div className="space-y-4">
      <PortalCollapsibleSection
        title="Weekly hours"
        surfaceMuted={false}
        contentClassName="px-4 pb-4"
        toggleDataAttr="vendor-availability-weekly-toggle"
        headerActions={
          <Button
            type="button"
            variant="outline"
            data-attr="vendor-availability-add-weekly"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => {
              if (weeklyFormOpen) {
                setWeeklyFormOpen(false);
                resetWeeklyForm();
              } else {
                resetWeeklyForm();
                setWeeklyFormOpen(true);
              }
            }}
          >
            {weeklyFormOpen ? "Cancel" : "+ Add window"}
          </Button>
        }
      >
        {weeklyFormOpen ? (
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2 rounded-xl border border-border bg-accent/20 p-3">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
              Day
              <Select
                className="h-9 min-w-[110px] rounded-md text-sm"
                value={weeklyDraft.weekday}
                onChange={(e) => setWeeklyDraft((d) => ({ ...d, weekday: Number(e.target.value) }))}
              >
                {WEEKDAY_DISPLAY_ORDER.map((wd) => (
                  <option key={wd} value={wd}>
                    {WEEKDAY_LABELS[wd]}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
              Start
              <Input
                type="time"
                value={weeklyDraft.start}
                onChange={(e) => setWeeklyDraft((d) => ({ ...d, start: e.target.value }))}
                className="h-9 w-[120px] rounded-md text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
              End
              <Input
                type="time"
                value={weeklyDraft.end}
                onChange={(e) => setWeeklyDraft((d) => ({ ...d, end: e.target.value }))}
                className="h-9 w-[120px] rounded-md text-sm"
              />
            </label>
            <Button
              type="button"
              variant="primary"
              data-attr="vendor-availability-save-weekly"
              className="h-9 rounded-full px-4 text-sm"
              disabled={saving}
              onClick={() => addWeeklyWindow()}
            >
              {weeklyEditingId ? "Save changes" : "Save"}
            </Button>
          </div>
        ) : null}

        <div className="mt-3 space-y-2">
          {WEEKDAY_DISPLAY_ORDER.map((wd) => {
            const windows = (weeklyByDay.get(wd) ?? []).filter((w) => !isFlexibleWeeklyRule(w));
            const flexible = flexibleRuleForDay(wd);
            return (
              <div key={wd} className="flex flex-wrap items-center gap-2">
                <span className="w-9 shrink-0 text-xs font-semibold uppercase tracking-wide text-muted">{WEEKDAY_LABELS[wd]}</span>
                <button
                  type="button"
                  data-attr={`vendor-availability-flexible-${WEEKDAY_LABELS[wd].toLowerCase()}`}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 transition ${
                    flexible
                      ? "bg-primary/10 text-primary ring-primary/30"
                      : "bg-accent/30 text-muted ring-border hover:text-foreground"
                  }`}
                  disabled={saving || busyId !== null}
                  onClick={() => void toggleFlexibleDay(wd)}
                >
                  Flexible
                </button>
                {flexible ? (
                  <span className="text-xs font-medium text-primary">Any time</span>
                ) : windows.length === 0 ? (
                  <span className="text-xs text-muted">Unavailable</span>
                ) : (
                  windows.map((w) =>
                    w.kind === "weekly" ? (
                      <span
                        key={w.id}
                        className="inline-flex items-center gap-1.5 rounded-full bg-accent/30 px-3 py-1 text-xs font-medium text-foreground ring-1 ring-border"
                      >
                        <button
                          type="button"
                          data-attr="vendor-availability-edit-weekly"
                          className={AVAILABILITY_EDIT_BTN}
                          onClick={() => startEditWeekly(w)}
                        >
                          {formatMinuteOfDayLabel(w.startMinute)}–{formatMinuteOfDayLabel(w.endMinute)}
                        </button>
                        <button
                          type="button"
                          data-attr="vendor-availability-remove-weekly"
                          aria-label={`Remove ${WEEKDAY_LABELS[wd]} ${formatMinuteOfDayLabel(w.startMinute)}–${formatMinuteOfDayLabel(w.endMinute)}`}
                          className={AVAILABILITY_REMOVE_BTN}
                          disabled={busyId === w.id}
                          onClick={() => void removeRule(w.id)}
                        >
                          ✕
                        </button>
                      </span>
                    ) : null,
                  )
                )}
              </div>
            );
          })}
        </div>
      </PortalCollapsibleSection>

      <PortalCollapsibleSection
        title="Open specific dates"
        subtitle="Open a one-off date for visits, even outside your weekly hours."
        surfaceMuted={false}
        contentClassName="px-4 pb-4"
        toggleDataAttr="vendor-availability-open-dates-toggle"
        headerActions={
          <Button
            type="button"
            variant="outline"
            data-attr="vendor-availability-add-open-date"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => {
              if (openFormOpen) {
                setOpenFormOpen(false);
                resetOpenForm();
              } else {
                resetOpenForm();
                setOpenFormOpen(true);
              }
            }}
          >
            {openFormOpen ? "Cancel" : "+ Open a date"}
          </Button>
        }
      >
        {openFormOpen ? (
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2 rounded-xl border border-border bg-accent/20 p-3">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
              Date
              <Input
                type="date"
                value={openDraft.date}
                onChange={(e) => setOpenDraft((d) => ({ ...d, date: e.target.value }))}
                className="h-9 w-[160px] rounded-md text-sm"
              />
            </label>
            <label className="flex items-center gap-2 pb-1.5 text-xs font-medium text-muted">
              <input
                type="checkbox"
                checked={openDraft.allDay}
                onChange={(e) => setOpenDraft((d) => ({ ...d, allDay: e.target.checked }))}
                className="h-4 w-4 rounded border-border"
              />
              All day
            </label>
            {!openDraft.allDay ? (
              <>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  Start
                  <Input
                    type="time"
                    value={openDraft.start}
                    onChange={(e) => setOpenDraft((d) => ({ ...d, start: e.target.value }))}
                    className="h-9 w-[120px] rounded-md text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  End
                  <Input
                    type="time"
                    value={openDraft.end}
                    onChange={(e) => setOpenDraft((d) => ({ ...d, end: e.target.value }))}
                    className="h-9 w-[120px] rounded-md text-sm"
                  />
                </label>
              </>
            ) : null}
            <label className="flex flex-1 min-w-[140px] flex-col gap-1 text-[11px] font-medium text-muted">
              Note (optional)
              <Input
                type="text"
                placeholder="e.g. Saturday availability"
                value={openDraft.note}
                onChange={(e) => setOpenDraft((d) => ({ ...d, note: e.target.value }))}
                className="h-9 rounded-md text-sm"
              />
            </label>
            <Button
              type="button"
              variant="primary"
              data-attr="vendor-availability-save-open-date"
              className="h-9 rounded-full px-4 text-sm"
              disabled={saving}
              onClick={() => addOpenDate()}
            >
              {openEditingId ? "Save changes" : "Save"}
            </Button>
          </div>
        ) : null}

        <div className="mt-3 space-y-1.5">
          {opens.length === 0 ? (
            <p className="text-xs text-muted">No specific dates opened.</p>
          ) : (
            opens.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs"
              >
                <button
                  type="button"
                  data-attr="vendor-availability-edit-open-date"
                  className={`text-left ${AVAILABILITY_EDIT_BTN}`}
                  onClick={() => startEditOpen(o)}
                >
                  <span className="font-medium text-foreground">
                    {new Date(`${o.specificDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </span>{" "}
                  ·{" "}
                  {o.startMinute === 0 && o.endMinute === 1440
                    ? "All day"
                    : `${formatMinuteOfDayLabel(o.startMinute)}–${formatMinuteOfDayLabel(o.endMinute)}`}
                  {o.note ? <span className="text-muted"> · {o.note}</span> : null}
                </button>
                <button
                  type="button"
                  data-attr="vendor-availability-remove-open-date"
                  aria-label={`Remove open date ${o.specificDate}`}
                  className={AVAILABILITY_REMOVE_BTN}
                  disabled={busyId === o.id}
                  onClick={() => void removeRule(o.id)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </PortalCollapsibleSection>

      <PortalCollapsibleSection
        title="Blocked dates"
        surfaceMuted={false}
        contentClassName="px-4 pb-4"
        toggleDataAttr="vendor-availability-blocked-toggle"
        headerActions={
          <Button
            type="button"
            variant="outline"
            data-attr="vendor-availability-add-block"
            className="h-8 rounded-full px-3 text-xs"
            onClick={() => {
              if (blockFormOpen) {
                setBlockFormOpen(false);
                resetBlockForm();
              } else {
                resetBlockForm();
                setBlockFormOpen(true);
              }
            }}
          >
            {blockFormOpen ? "Cancel" : "+ Block a date"}
          </Button>
        }
      >
        {blockFormOpen ? (
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2 rounded-xl border border-border bg-accent/20 p-3">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
              Date
              <Input
                type="date"
                value={blockDraft.date}
                onChange={(e) => setBlockDraft((d) => ({ ...d, date: e.target.value }))}
                className="h-9 w-[160px] rounded-md text-sm"
              />
            </label>
            <label className="flex items-center gap-2 pb-1.5 text-xs font-medium text-muted">
              <input
                type="checkbox"
                checked={blockDraft.allDay}
                onChange={(e) => setBlockDraft((d) => ({ ...d, allDay: e.target.checked }))}
                className="h-4 w-4 rounded border-border"
              />
              All day
            </label>
            {!blockDraft.allDay ? (
              <>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  Start
                  <Input
                    type="time"
                    value={blockDraft.start}
                    onChange={(e) => setBlockDraft((d) => ({ ...d, start: e.target.value }))}
                    className="h-9 w-[120px] rounded-md text-sm"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] font-medium text-muted">
                  End
                  <Input
                    type="time"
                    value={blockDraft.end}
                    onChange={(e) => setBlockDraft((d) => ({ ...d, end: e.target.value }))}
                    className="h-9 w-[120px] rounded-md text-sm"
                  />
                </label>
              </>
            ) : null}
            <label className="flex flex-1 min-w-[140px] flex-col gap-1 text-[11px] font-medium text-muted">
              Note (optional)
              <Input
                type="text"
                placeholder="e.g. Vacation"
                value={blockDraft.note}
                onChange={(e) => setBlockDraft((d) => ({ ...d, note: e.target.value }))}
                className="h-9 rounded-md text-sm"
              />
            </label>
            <Button
              type="button"
              variant="primary"
              data-attr="vendor-availability-save-block"
              className="h-9 rounded-full px-4 text-sm"
              disabled={saving}
              onClick={() => addBlock()}
            >
              {blockEditingId ? "Save changes" : "Save"}
            </Button>
          </div>
        ) : null}

        <div className="mt-3 space-y-1.5">
          {blocks.length === 0 ? (
            <p className="text-xs text-muted">No blocked dates.</p>
          ) : (
            blocks.map((b) => (
              <div
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs"
              >
                <button
                  type="button"
                  data-attr="vendor-availability-edit-block"
                  className={`text-left ${AVAILABILITY_EDIT_BTN}`}
                  onClick={() => startEditBlock(b)}
                >
                  <span className="font-medium text-foreground">
                    {new Date(`${b.specificDate}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </span>{" "}
                  ·{" "}
                  {b.startMinute === 0 && b.endMinute === 1440
                    ? "All day"
                    : `${formatMinuteOfDayLabel(b.startMinute)}–${formatMinuteOfDayLabel(b.endMinute)}`}
                  {b.note ? <span className="text-muted"> · {b.note}</span> : null}
                </button>
                <button
                  type="button"
                  data-attr="vendor-availability-remove-block"
                  aria-label={`Remove blocked date ${b.specificDate}`}
                  className={AVAILABILITY_REMOVE_BTN}
                  disabled={busyId === b.id}
                  onClick={() => void removeRule(b.id)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </PortalCollapsibleSection>
      {!loaded ? <p className="text-xs text-muted">Loading availability…</p> : null}
    </div>
  );
}

/** Vendor's own Settings — business profile, work capabilities (feeds auto-match), availability, and feedback. */
export function VendorSettingsPanel() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();

  const [profileDraft, setProfileDraft] = useState<VendorProfileDraft>(() => (demo ? DEMO_VENDOR_PROFILE : EMPTY_PROFILE));
  const [trades, setTrades] = useState<string[]>(() => (demo ? DEMO_VENDOR_TRADES : []));
  const [profileLoading, setProfileLoading] = useState(() => !demo);
  const [profileSaving, setProfileSaving] = useState(false);
  const [capabilitiesSaving, setCapabilitiesSaving] = useState(false);
  const [unlinked, setUnlinked] = useState(false);

  useEffect(() => {
    if (demo) return;
    void fetch("/api/vendor/profile", { credentials: "include" })
      .then((r) => r.json())
      .then(
        (data: {
          profile?: VendorProfileApiRow | null;
          linked?: boolean;
          contact?: { phone?: string; preferredLanguage?: string; smsConsent?: boolean };
        }) => {
          setUnlinked(data.linked === false);
          const p = data.profile;
          const contact = data.contact;
          setProfileDraft({
            name: p?.name ?? "",
            phone: p?.phone ?? "",
            email: p?.email ?? "",
            preferredLanguage: contact?.preferredLanguage || p?.preferredLanguage || "",
            smsConsent: contact?.smsConsent ?? false,
          });
          if (p) setTrades(p.trades && p.trades.length > 0 ? p.trades : p.trade ? [p.trade] : []);
        },
      )
      .finally(() => setProfileLoading(false));
  }, [demo]);

  async function saveProfile() {
    setProfileSaving(true);
    try {
      if (demo) {
        showToast("Profile saved.");
        return;
      }
      const res = await fetch("/api/vendor/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: profileDraft.name,
          phone: profileDraft.phone,
          email: profileDraft.email,
          preferredLanguage: profileDraft.preferredLanguage,
          smsConsent: profileDraft.smsConsent,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      showToast("Profile saved.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setProfileSaving(false);
    }
  }

  function toggleTrade(trade: string, on: boolean) {
    setTrades((cur) => {
      const set = new Set(cur);
      if (on) set.add(trade);
      else set.delete(trade);
      return [...set];
    });
  }

  async function saveCapabilities() {
    setCapabilitiesSaving(true);
    try {
      if (demo) {
        showToast("Capabilities saved.");
        return;
      }
      const res = await fetch("/api/vendor/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ trades }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      showToast("Capabilities saved.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setCapabilitiesSaving(false);
    }
  }

  return (
    <ManagerPortalPageShell title="Settings" hideTitleOnMobileNav subtitle="Manage your business profile, capabilities, and account preferences.">
      <PortalSettingsSections>
        {unlinked ? (
          <p className="rounded-lg border px-4 py-3 text-sm portal-banner-pending" data-attr="vendor-settings-unlinked-banner">
            Waiting on a property manager to connect with you. You&apos;ll be able to save your profile once linked.
          </p>
        ) : null}

        <PortalSettingsSection title="Business profile" description="Shown to the property managers you work with.">
          <PortalSettingsGroup>
          {profileLoading ? (
            <p className="px-4 py-4 text-sm text-muted">Loading…</p>
          ) : (
            <PortalSettingsFormBody>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
                Business name
                <Input
                  value={profileDraft.name}
                  onChange={(e) => setProfileDraft({ ...profileDraft, name: e.target.value })}
                  data-attr="vendor-settings-name"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Phone
                <Input
                  value={profileDraft.phone}
                  onChange={(e) => setProfileDraft({ ...profileDraft, phone: e.target.value })}
                  data-attr="vendor-settings-phone"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Email
                <Input
                  type="email"
                  value={profileDraft.email}
                  onChange={(e) => setProfileDraft({ ...profileDraft, email: e.target.value })}
                  data-attr="vendor-settings-email"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Preferred language / Idioma
                <Select
                  value={profileDraft.preferredLanguage}
                  onChange={(e) => setProfileDraft({ ...profileDraft, preferredLanguage: e.target.value })}
                  data-attr="vendor-language-select"
                >
                  <option value="">Select…</option>
                  <option value="en">English</option>
                  <option value="es">Español</option>
                </Select>
              </label>
              <label className="flex items-start gap-2 text-xs font-medium text-muted sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border"
                  checked={profileDraft.smsConsent}
                  onChange={(e) => setProfileDraft({ ...profileDraft, smsConsent: e.target.checked })}
                  data-attr="vendor-sms-consent"
                />
                <span>
                  Text me about jobs at this number. Message and data rates may apply; reply STOP to opt out.
                </span>
              </label>
            </div>
            </PortalSettingsFormBody>
          )}

          <div className="border-t border-border px-4 py-4">
            <Button
              variant="primary"
              className="px-4 text-[13px]"
              onClick={() => saveProfile()}
              disabled={profileSaving || profileLoading || unlinked}
              data-attr="vendor-settings-profile-save"
            >
              {profileSaving ? "Saving…" : "Save"}
            </Button>
          </div>
          </PortalSettingsGroup>
        </PortalSettingsSection>

        <PortalSettingsSection
          title="Work capabilities"
          description="Managers use this to match you with the right work orders."
        >
          <PortalSettingsGroup>
          {profileLoading ? (
            <p className="px-4 py-4 text-sm text-muted">Loading…</p>
          ) : (
            <PortalSettingsFormBody>
            <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3 sm:grid-cols-2 lg:grid-cols-3">
              {VENDOR_TRADE_OPTIONS.map((option) => {
                const on = trades.includes(option);
                return (
                  <label key={option} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border"
                      checked={on}
                      onChange={(e) => toggleTrade(option, e.target.checked)}
                      data-attr={`vendor-capability-${option.toLowerCase().replace(/\s+/g, "-")}`}
                    />
                    <span className="font-medium text-foreground">{option}</span>
                  </label>
                );
              })}
            </div>
            </PortalSettingsFormBody>
          )}

          <div className="border-t border-border px-4 py-4">
            <Button
              variant="primary"
              className="px-4 text-[13px]"
              onClick={() => saveCapabilities()}
              disabled={capabilitiesSaving || profileLoading || unlinked}
              data-attr="vendor-settings-capabilities-save"
            >
              {capabilitiesSaving ? "Saving…" : "Save capabilities"}
            </Button>
          </div>
          </PortalSettingsGroup>
        </PortalSettingsSection>

        <AssistantCustomInstructionsSetting role="vendor" />

        <PortalTextNotificationsBlock dataAttrPrefix="vendor" demo={demo} />

        <PortalBugFeedbackPanel reporterRole="vendor" embedded />

        <PortalSettingsExtras currentKind="vendor" />
      </PortalSettingsSections>
    </ManagerPortalPageShell>
  );
}
