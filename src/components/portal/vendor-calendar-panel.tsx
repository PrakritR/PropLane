"use client";

import { useEffect, useMemo, useState } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { MEETING_CONFIRMED_COLOR, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, VendorAvailabilityEditor } from "@/components/portal/vendor-settings-panel";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { CalendarClock } from "lucide-react";
import { readVendorWorkOrderRows, syncManagerWorkOrdersFromServer, MANAGER_WORK_ORDERS_EVENT } from "@/lib/manager-work-orders-storage";
import {
  SLOT_DURATION_MINUTES,
  toLocalDateStr,
  installAvailabilityDateSetForStorageKey,
} from "@/lib/demo-admin-scheduling";
import { isFlexibleWeeklyRule, slotKeysFromWeeklyRules, type VendorAvailabilityRule } from "@/lib/vendor-availability";
import { calendarMeetingMatchesQuery } from "@/lib/manager-calendar-tour-meetings";
import { portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";

function propertyLabel(row: DemoManagerWorkOrderRow): string {
  const unit = row.unit?.trim();
  return unit && unit !== "—" ? `${row.propertyName} · ${unit}` : row.propertyName;
}

const VENDOR_VISIT_DEFAULT_DURATION_MINUTES = 60;

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

/**
 * A disposable calendar paint cache derived wholly from the canonical
 * availability API. Kept as a general-purpose pure utility (covered directly
 * by `vendor-calendar-availability-read-only.test.tsx`) even though the
 * vendor Calendar's own agenda view (C155) no longer paints an availability
 * grid itself — a future grid surface can still install into the same
 * `installAvailabilityDateSetForStorageKey` cache this way.
 */
export function installVendorAvailabilityPaintCache(
  storageKey: string,
  rules: VendorAvailabilityRule[],
  window: { from: Date; dayCount: number } = { from: new Date(), dayCount: 7 },
) {
  // Flexible is a legacy persisted rule shape. Project it to the historic
  // 8am–6pm window for painting only; reading the calendar must not rewrite it.
  const paintRules = rules.map((rule) =>
    isFlexibleWeeklyRule(rule)
      ? { ...rule, startMinute: 8 * 60, endMinute: 18 * 60, note: undefined }
      : rule,
  );
  const from = new Date(window.from);
  from.setHours(0, 0, 0, 0);
  const dayCount = Math.max(1, window.dayCount);
  const until = new Date(from);
  until.setDate(from.getDate() + dayCount);
  const keys = new Set(
    slotKeysFromWeeklyRules(paintRules, from, Math.ceil(dayCount / 7)).filter((key) => {
      const [date] = key.split(":");
      return Boolean(date && date >= toLocalDateStr(from) && date < toLocalDateStr(until));
    }),
  );
  for (const rule of rules) {
    if (rule.kind !== "open" && rule.kind !== "block") continue;
    if (rule.specificDate < toLocalDateStr(from) || rule.specificDate >= toLocalDateStr(until)) continue;
    const start = Math.floor(rule.startMinute / SLOT_DURATION_MINUTES);
    const end = Math.ceil(rule.endMinute / SLOT_DURATION_MINUTES);
    for (let slot = start; slot < end; slot += 1) {
      const key = `${rule.specificDate}:${slot}`;
      if (rule.kind === "open") keys.add(key);
      else keys.delete(key);
    }
  }
  installAvailabilityDateSetForStorageKey(keys, storageKey);
}

function agendaDateHeaderLabel(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  const today = toLocalDateStr(new Date());
  const tomorrow = toLocalDateStr(new Date(Date.now() + 86_400_000));
  const formatted = date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  if (dateStr === today) return `Today · ${formatted}`;
  if (dateStr === tomorrow) return `Tomorrow · ${formatted}`;
  return formatted;
}

type VendorCalendarAgendaGroup = { dateStr: string; meetings: DemoMeeting[] };

function groupMeetingsByDate(meetings: DemoMeeting[]): VendorCalendarAgendaGroup[] {
  const byDate = new Map<string, DemoMeeting[]>();
  for (const meeting of [...meetings].sort((a, b) => a.startIso.localeCompare(b.startIso))) {
    const bucket = byDate.get(meeting.dateStr);
    if (bucket) bucket.push(meeting);
    else byDate.set(meeting.dateStr, [meeting]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dateStr, meetings]) => ({ dateStr, meetings }));
}

/**
 * Vendor Calendar (C155) — one continuous, chronological agenda of scheduled
 * services grouped under date headers. No List/Day/Week/Month mode switcher:
 * every scheduled visit, always in one view. `view` is still accepted (and
 * ignored) so existing callers — `portal-calendar.tsx`'s
 * `vendorCalendarViewHref`-driven routing, `demo-section-renderer.tsx` —
 * don't need a matching change to keep compiling.
 */
export function VendorCalendarPanel(props: { view?: string } = {}) {
  void props.view;
  const { userId, ready } = usePortalSession();
  const demo = isDemoModeActive();
  const [rows, setRows] = useState<DemoManagerWorkOrderRow[]>(() => readVendorWorkOrderRows());
  const [listSearch, setListSearch] = useState("");

  useEffect(() => {
    const sync = () => setRows(readVendorWorkOrderRows());
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
    void syncManagerWorkOrdersFromServer().then(() => sync());
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, sync);
  }, []);

  const visitMeetings = useMemo<DemoMeeting[]>(() => {
    return rows
      .filter((r) => r.scheduledAtIso && r.bucket !== "completed")
      .map(vendorMeetingFromRow)
      .filter((meeting) => meeting !== null);
  }, [rows]);

  const vendorMeetings = useMemo(() => {
    const scoped = visitMeetings;
    const needle = listSearch.trim();
    if (!needle) return scoped;
    return scoped.filter((meeting) => calendarMeetingMatchesQuery(meeting, needle));
  }, [listSearch, visitMeetings]);

  const agendaGroups = useMemo(() => groupMeetingsByDate(vendorMeetings), [vendorMeetings]);

  if (!demo && !ready) {
    return (
      <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav>
        <p className="text-sm font-semibold text-foreground">Loading calendar…</p>
      </ManagerPortalPageShell>
    );
  }

  if (!demo && !userId) {
    return (
      <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav>
        <p className="text-sm font-semibold text-foreground">Sign in to manage your availability.</p>
      </ManagerPortalPageShell>
    );
  }

  const searchNeedle = listSearch.trim();
  const searchMiss = Boolean(searchNeedle) && vendorMeetings.length === 0 && visitMeetings.length > 0;

  return (
    <ManagerPortalPageShell title="Calendar" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        search={{
          value: listSearch,
          onChange: setListSearch,
          placeholder: "Search calendar",
          dataAttr: "vendor-calendar-search",
        }}
        actions={
          <PortalIconAction
            icon={CalendarClock}
            label="Set availability"
            data-attr="vendor-calendar-set-availability"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, {
                  detail: { date: toLocalDateStr(new Date()) },
                }),
              );
            }}
          />
        }
      />
      {searchMiss ? (
        <PortalListEmptyCard
          section="calendar"
          tone="muted"
          title={portalEmptyNoMatchTitle("events", listSearch)}
          clear={{
            label: "Clear search",
            onClick: () => setListSearch(""),
            dataAttr: "vendor-calendar-empty-clear-search",
          }}
          dataAttr="vendor-calendar-empty-search"
        />
      ) : (
        <PortalRecordListSurface
          isEmpty={vendorMeetings.length === 0}
          emptyCard={{ title: "No scheduled services", section: "calendar" }}
          dataAttr="vendor-calendar-list"
        >
          {agendaGroups.map((group) => (
            <div key={group.dateStr} className="mb-3 last:mb-0" data-attr="vendor-calendar-agenda-day">
              <h2 className="mb-1 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">
                {agendaDateHeaderLabel(group.dateStr)}
              </h2>
              {group.meetings.map((meeting) => (
                <PortalPropertyRecordRow
                  key={meeting.id}
                  title={meeting.title}
                  address={meeting.propertyTitle ?? "—"}
                  facts={new Date(meeting.startIso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  dataAttr="vendor-calendar-list-row"
                />
              ))}
            </div>
          ))}
        </PortalRecordListSurface>
      )}
      <VendorAvailabilityEditor dialog />
    </ManagerPortalPageShell>
  );
}
