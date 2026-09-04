"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalCalendarPanels, MEETING_CONFIRMED_COLOR, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { VendorFlexibleSettingsModal } from "@/components/portal/vendor-flexible-settings-modal";
import { VendorWorkEventModal, type VendorWorkEventDraft } from "@/components/portal/vendor-work-event-modal";
import { VENDOR_AVAILABILITY_CHANGED_EVENT } from "@/components/portal/vendor-settings-panel";
import { readVendorWorkOrderRows, syncManagerWorkOrdersFromServer, MANAGER_WORK_ORDERS_EVENT } from "@/lib/manager-work-orders-storage";
import {
  SLOT_DURATION_MINUTES,
  toLocalDateStr,
  vendorAvailabilityStorageKey,
} from "@/lib/demo-admin-scheduling";
import {
  fetchVendorAssignedTasks,
  vendorTaskToMeeting,
  VENDOR_TASKS_EVENT,
} from "@/lib/vendor-tasks.client";
import {
  DEFAULT_FLEXIBLE_TIMING_RANK,
  fetchVendorAvailability,
  fetchVendorFlexiblePreferences,
  flexibleWeekdaysFromRules,
  isFlexibleWeeklyRule,
  saveVendorFlexiblePreferences,
  saveVendorWeeklyRule,
  deleteVendorAvailabilityRule,
  isVendorWorkMeetingId,
  saveVendorEventRule,
  VENDOR_WORK_MEETING_ID_PREFIX,
  writeVendorFlexiblePreferencesToStorage,
  type VendorAvailabilityRule,
  type VendorFlexiblePreferences,
} from "@/lib/vendor-availability";
import { usePortalSession } from "@/hooks/use-portal-session";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

const VENDOR_VISIT_DEFAULT_DURATION_MINUTES = 60;
const VENDOR_WORK_COLOR =
  "bg-violet-500/25 text-violet-950 ring-violet-400/35 [html[data-theme=dark]_&]:bg-violet-500/20 [html[data-theme=dark]_&]:text-violet-100";
const VENDOR_TASK_COLOR =
  "bg-sky-500/25 text-sky-950 ring-sky-400/35 [html[data-theme=dark]_&]:bg-sky-500/20 [html[data-theme=dark]_&]:text-sky-100";
let demoAvailabilityRuleCounter = 0;

function vendorWorkMeetingFromRule(rule: Extract<VendorAvailabilityRule, { kind: "event" }>): DemoMeeting {
  const [year, month, day] = rule.specificDate.split("-").map(Number);
  const start = new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  start.setMinutes(rule.startMinute);
  const end = new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  end.setMinutes(rule.endMinute);
  const durationMinutes = Math.max(SLOT_DURATION_MINUTES, rule.endMinute - rule.startMinute);
  return {
    id: `${VENDOR_WORK_MEETING_ID_PREFIX}${rule.id}`,
    source: "external",
    sourceId: rule.id,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateStr: rule.specificDate,
    startSlot: Math.max(0, Math.floor(rule.startMinute / SLOT_DURATION_MINUTES)),
    span: Math.max(1, Math.ceil(durationMinutes / SLOT_DURATION_MINUTES)),
    durationMinutes,
    title: rule.note?.trim() || "Work",
    color: VENDOR_WORK_COLOR,
    statusLabel: "My work",
  };
}

function draftFromSlot(dateStr: string, slotIdx: number): VendorWorkEventDraft {
  const startMinute = slotIdx * SLOT_DURATION_MINUTES;
  return {
    specificDate: dateStr,
    startMinute,
    endMinute: startMinute + VENDOR_VISIT_DEFAULT_DURATION_MINUTES,
    title: "",
  };
}

function vendorMeetingFromRow(row: DemoManagerWorkOrderRow): DemoMeeting | null {
  if (!row.scheduledAtIso) return null;
  const start = new Date(row.scheduledAtIso);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + VENDOR_VISIT_DEFAULT_DURATION_MINUTES * 60_000);
  return {
    id: `vendor-visit-${row.id}`,
    source: "external",
    sourceId: row.id,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateStr: toLocalDateStr(start),
    startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
    span: Math.max(1, Math.ceil(VENDOR_VISIT_DEFAULT_DURATION_MINUTES / SLOT_DURATION_MINUTES)),
    durationMinutes: VENDOR_VISIT_DEFAULT_DURATION_MINUTES,
    title: row.title,
    color: MEETING_CONFIRMED_COLOR,
    statusLabel: "Scheduled",
    propertyTitle: propertyLabel(row),
    propertyId: row.propertyId,
    notes: row.description || undefined,
  };
}

function notifyAvailabilityChanged(rules: VendorAvailabilityRule[]) {
  window.dispatchEvent(new CustomEvent(VENDOR_AVAILABILITY_CHANGED_EVENT, { detail: { rules } }));
}

/** Drag-painted availability blocks + per-day flexible scheduling for vendor visits. */
export function VendorCalendarPanel() {
  const { showToast } = useAppUi();
  const { userId, ready } = usePortalSession();
  const demo = isDemoModeActive();
  const [rows, setRows] = useState<DemoManagerWorkOrderRow[]>(() => readVendorWorkOrderRows());
  const [availabilityRules, setAvailabilityRules] = useState<VendorAvailabilityRule[]>([]);
  const [preferences, setPreferences] = useState<VendorFlexiblePreferences>({
    timingRank: [...DEFAULT_FLEXIBLE_TIMING_RANK],
  });
  const [flexModalOpen, setFlexModalOpen] = useState(false);
  const [workModalOpen, setWorkModalOpen] = useState(false);
  const [workDraft, setWorkDraft] = useState<VendorWorkEventDraft | null>(null);
  const [workSaving, setWorkSaving] = useState(false);
  const [prefsSaving, setPrefsSaving] = useState(false);
  const [calendarRefreshSignal, setCalendarRefreshSignal] = useState(0);
  const [assignedTasks, setAssignedTasks] = useState<Awaited<ReturnType<typeof fetchVendorAssignedTasks>>>([]);

  const storageKey = useMemo(() => (userId ? vendorAvailabilityStorageKey(userId) : null), [userId]);
  const flexibleWeekdays = useMemo(() => flexibleWeekdaysFromRules(availabilityRules), [availabilityRules]);

  const reloadAvailability = useCallback(async () => {
    if (demo) return;
    const [rules, prefs] = await Promise.all([fetchVendorAvailability(), fetchVendorFlexiblePreferences()]);
    setAvailabilityRules(rules);
    setPreferences(prefs);
    if (userId) writeVendorFlexiblePreferencesToStorage(userId, prefs);
  }, [demo, userId]);

  useEffect(() => {
    if (!userId) return;
    const loadTasks = () => {
      void fetchVendorAssignedTasks(userId).then(setAssignedTasks).catch(() => undefined);
    };
    loadTasks();
    window.addEventListener(VENDOR_TASKS_EVENT, loadTasks);
    return () => window.removeEventListener(VENDOR_TASKS_EVENT, loadTasks);
  }, [userId]);

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
  }, []);

  useEffect(() => {
    void reloadAvailability();
  }, [reloadAvailability]);

  // Vendors use /api/vendor/availability — not manager portal-schedule-records.
  useEffect(() => {
    const bump = (event: Event) => {
      const detail = (event as CustomEvent<{ rules?: VendorAvailabilityRule[] }>).detail;
      if (detail?.rules) setAvailabilityRules(detail.rules);
    };
    window.addEventListener(VENDOR_AVAILABILITY_CHANGED_EVENT, bump);
    return () => window.removeEventListener(VENDOR_AVAILABILITY_CHANGED_EVENT, bump);
  }, []);

  const vendorMeetings = useMemo<DemoMeeting[]>(() => {
    const visits = rows
      .filter((r) => r.scheduledAtIso && r.bucket !== "completed")
      .map(vendorMeetingFromRow)
      // A hand-written predicate here asserted `meeting is DemoMeeting`, which TypeScript rejects:
      // the `satisfies`-checked object literal is NARROWER than DemoMeeting, so the wider type is
      // not assignable back to the parameter. A plain null check narrows correctly on its own.
      .filter((meeting) => meeting !== null);
    const work = availabilityRules
      .filter((rule): rule is Extract<VendorAvailabilityRule, { kind: "event" }> => rule.kind === "event")
      .map(vendorWorkMeetingFromRule);
    const tasks = assignedTasks
      .map((task) => {
        const slot = vendorTaskToMeeting(task);
        if (!slot) return null;
        const start = new Date(slot.startIso);
        const end = new Date(slot.endIso);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
        const durationMinutes = Math.max(
          SLOT_DURATION_MINUTES,
          Math.round((end.getTime() - start.getTime()) / 60_000),
        );
        return {
          id: slot.id,
          source: "external" as const,
          sourceId: task.id,
          startIso: slot.startIso,
          endIso: slot.endIso,
          dateStr: toLocalDateStr(start),
          startSlot: Math.max(0, Math.floor((start.getHours() * 60 + start.getMinutes()) / SLOT_DURATION_MINUTES)),
          span: Math.max(1, Math.ceil(durationMinutes / SLOT_DURATION_MINUTES)),
          durationMinutes,
          title: slot.title,
          color: VENDOR_TASK_COLOR,
          statusLabel: "Task",
          propertyTitle: slot.propertyTitle,
        } satisfies DemoMeeting;
      })
      // A hand-written predicate here asserted `meeting is DemoMeeting`, which TypeScript rejects:
      // the `satisfies`-checked object literal is NARROWER than DemoMeeting, so the wider type is
      // not assignable back to the parameter. A plain null check narrows correctly on its own.
      .filter((meeting) => meeting !== null);
    return [...tasks, ...work, ...visits];
  }, [assignedTasks, availabilityRules, rows]);

  const openWorkDraft = useCallback((draft: VendorWorkEventDraft) => {
    setWorkDraft(draft);
    setWorkModalOpen(true);
  }, []);

  const saveWorkDraft = useCallback(
    async (draft: VendorWorkEventDraft) => {
      setWorkSaving(true);
      if (demo) {
        const nextRule: VendorAvailabilityRule = {
          id: draft.id ?? `demo-avail-event-${++demoAvailabilityRuleCounter}`,
          kind: "event",
          specificDate: draft.specificDate,
          startMinute: draft.startMinute,
          endMinute: draft.endMinute,
          note: draft.title,
        };
        const next = [
          ...availabilityRules.filter((rule) => rule.id !== nextRule.id),
          nextRule,
        ];
        setAvailabilityRules(next);
        notifyAvailabilityChanged(next);
        setWorkSaving(false);
        setWorkModalOpen(false);
        setWorkDraft(null);
        showToast(draft.id ? "Work block updated." : "Work added to your calendar.");
        return;
      }
      const result = await saveVendorEventRule({
        id: draft.id,
        specificDate: draft.specificDate,
        startMinute: draft.startMinute,
        endMinute: draft.endMinute,
        note: draft.title,
      });
      setWorkSaving(false);
      if (!result.ok) {
        showToast(result.error ?? "Could not save work block.");
        return;
      }
      setWorkModalOpen(false);
      setWorkDraft(null);
      showToast(draft.id ? "Work block updated." : "Work added to your calendar.");
      await reloadAvailability();
    },
    [availabilityRules, demo, reloadAvailability, showToast],
  );

  const deleteWorkDraft = useCallback(
    async (id: string) => {
      setWorkSaving(true);
      if (demo) {
        const next = availabilityRules.filter((rule) => rule.id !== id);
        setAvailabilityRules(next);
        notifyAvailabilityChanged(next);
        setWorkSaving(false);
        setWorkModalOpen(false);
        setWorkDraft(null);
        showToast("Work block removed.");
        return;
      }
      const result = await deleteVendorAvailabilityRule(id);
      setWorkSaving(false);
      if (!result.ok) {
        showToast(result.error ?? "Could not delete work block.");
        return;
      }
      setWorkModalOpen(false);
      setWorkDraft(null);
      showToast("Work block removed.");
      await reloadAvailability();
    },
    [availabilityRules, demo, reloadAvailability, showToast],
  );

  const toggleFlexibleDay = useCallback(
    async (weekday: number) => {
      const existing = availabilityRules.find(
        (r) => r.kind === "weekly" && r.weekday === weekday && isFlexibleWeeklyRule(r),
      );
      if (existing) {
        if (demo) {
          const next = availabilityRules.filter((r) => r.id !== existing.id);
          setAvailabilityRules(next);
          notifyAvailabilityChanged(next);
          showToast("Flexible schedule removed.");
          return;
        }
        const result = await deleteVendorAvailabilityRule(existing.id);
        if (!result.ok) {
          showToast(result.error ?? "Could not update flexible day.");
          return;
        }
        showToast("Flexible schedule removed.");
        await reloadAvailability();
        return;
      }

      if (demo) {
        const next = [
          ...availabilityRules.filter((r) => !(r.kind === "weekly" && r.weekday === weekday && isFlexibleWeeklyRule(r))),
          {
            id: `demo-avail-flex-${++demoAvailabilityRuleCounter}`,
            kind: "weekly" as const,
            weekday,
            startMinute: 0,
            endMinute: 1440,
            note: "Flexible",
          },
        ];
        setAvailabilityRules(next);
        notifyAvailabilityChanged(next);
        showToast("Marked flexible. Visits can auto-schedule by your timing preferences.");
        return;
      }

      const result = await saveVendorWeeklyRule({
        weekday,
        startMinute: 0,
        endMinute: 1440,
        note: "Flexible",
      });
      if (!result.ok) {
        showToast(result.error ?? "Could not mark day as flexible.");
        return;
      }
      showToast("Marked flexible. Visits can auto-schedule by your timing preferences.");
      await reloadAvailability();
    },
    [availabilityRules, demo, reloadAvailability, showToast],
  );

  const savePreferences = useCallback(
    async (next: VendorFlexiblePreferences) => {
      setPrefsSaving(true);
      if (demo) {
        setPreferences(next);
        if (userId) writeVendorFlexiblePreferencesToStorage(userId, next);
        setPrefsSaving(false);
        setFlexModalOpen(false);
        showToast("Flexible timing preferences saved.");
        return;
      }
      const result = await saveVendorFlexiblePreferences(next);
      setPrefsSaving(false);
      if (!result.ok) {
        showToast(result.error ?? "Could not save preferences.");
        return;
      }
      setPreferences(next);
      if (userId) writeVendorFlexiblePreferencesToStorage(userId, next);
      setFlexModalOpen(false);
      showToast("Flexible timing preferences saved.");
    },
    [demo, showToast, userId],
  );

  if (!demo && !ready) {
    return (
      <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav>
        <p className="text-sm text-muted">Loading calendar…</p>
      </ManagerPortalPageShell>
    );
  }

  if (!demo && !userId) {
    return (
      <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav>
        <p className="text-sm text-muted">Sign in to manage your availability.</p>
      </ManagerPortalPageShell>
    );
  }

  return (
    <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav>
      <PortalCalendarPanels
          storageKey={storageKey}
          readOnly={false}
          compactAvailability
          defaultViewMode="week"
          availabilityHeading="Availability"
          eventSummaryLabel="visit"
          calendarRefreshSignal={calendarRefreshSignal}
          externalMeetings={vendorMeetings}
          vendorDayFlexibility={{
            flexibleWeekdays,
            onToggleFlexibleDay: (weekday) => void toggleFlexibleDay(weekday),
            onOpenFlexibleSettings: () => setFlexModalOpen(true),
          }}
          vendorCalendarActions={{
            onAddFromSlot: (dateStr, slotIdx) => openWorkDraft(draftFromSlot(dateStr, slotIdx)),
            canEditMeeting: (meeting) => isVendorWorkMeetingId(meeting.id),
            onEditMeeting: (meeting) => {
              const rule = availabilityRules.find((item) => item.id === meeting.sourceId && item.kind === "event");
              if (!rule || rule.kind !== "event") return;
              openWorkDraft({
                id: rule.id,
                specificDate: rule.specificDate,
                startMinute: rule.startMinute,
                endMinute: rule.endMinute,
                title: rule.note?.trim() || meeting.title,
              });
            },
            onAddWork: () => {
              const today = toLocalDateStr(new Date());
              openWorkDraft(draftFromSlot(today, 18));
            },
          }}
        />
      <VendorFlexibleSettingsModal
        open={flexModalOpen}
        preferences={preferences}
        saving={prefsSaving}
        onClose={() => setFlexModalOpen(false)}
        onSave={(next) => void savePreferences(next)}
      />
      <VendorWorkEventModal
        open={workModalOpen}
        draft={workDraft}
        saving={workSaving}
        onClose={() => {
          if (workSaving) return;
          setWorkModalOpen(false);
          setWorkDraft(null);
        }}
        onSave={(draft) => void saveWorkDraft(draft)}
        onDelete={workDraft?.id ? (id) => void deleteWorkDraft(id) : undefined}
      />
    </ManagerPortalPageShell>
  );
}
