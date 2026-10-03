/**
 * Day / time dropdown options for manager tour reschedule — same open-slot
 * source as schedule-a-tour (`fetchOpenTourSlotsForProperty` → listOpenTourSlots).
 */
import { formatAvailabilitySlotLabel } from "@/lib/demo-admin-scheduling";
import { formatPacificDateTime, pacificCalendarDateYmd } from "@/lib/pacific-time";
import {
  openSlotKeysForDate,
  slotKeyDateStr,
  slotKeyIndex,
  type SlotHosts,
} from "@/lib/schedule-tour-simple";
import { isoWindowFromSlotKey, slotKeyForInstant } from "@/lib/tour-slot-math";

export type RescheduleDayOption = { value: string; label: string; disabled: boolean };
export type RescheduleTimeOption = { value: string; label: string; slotKey: string };

const DAY_MS = 86400000;

function addCalendarDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const base = Date.UTC(y!, m! - 1, d!);
  return new Date(base + delta * DAY_MS).toISOString().slice(0, 10);
}

function formatDayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  const md = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${wd}, ${md}`;
}

/** Merge the tour being moved back into offered slots when the public route subtracts it. */
export function slotHostsForReschedule(slotHosts: SlotHosts, currentStartIso: string): SlotHosts {
  const key = slotKeyForInstant(currentStartIso);
  if (!key || (slotHosts[key]?.length ?? 0) > 0) return slotHosts;
  const hosts = Object.values(slotHosts).find((h) => h.length > 0) ?? [];
  if (hosts.length === 0) return slotHosts;
  return { ...slotHosts, [key]: hosts };
}

export function buildRescheduleDayOptions(args: {
  slotHosts: SlotHosts;
  currentStartIso: string;
  maxDays?: number;
}): RescheduleDayOption[] {
  const maxDays = args.maxDays ?? 21;
  const hosts = slotHostsForReschedule(args.slotHosts, args.currentStartIso);
  const currentDay = slotKeyDateStr(slotKeyForInstant(args.currentStartIso) ?? "") || args.currentStartIso.slice(0, 10);
  const today = pacificCalendarDateYmd();
  const start = addCalendarDays(today, 0);
  const startMs = Date.parse(`${start}T12:00:00.000Z`);
  const curMs = Date.parse(`${currentDay}T12:00:00.000Z`);
  const firstMs = Math.max(startMs, curMs - 2 * DAY_MS);
  const firstDay = new Date(firstMs).toISOString().slice(0, 10);
  const days: string[] = [];
  for (let i = 0; i < maxDays; i += 1) {
    days.push(addCalendarDays(firstDay, i));
  }
  if (!days.includes(currentDay)) days.unshift(currentDay);
  return days.map((ymd) => {
    const open = openSlotKeysForDate(hosts, ymd);
    return {
      value: ymd,
      label: `${formatDayLabel(ymd)}${open.length === 0 ? " · No open times" : ""}`,
      disabled: open.length === 0,
    };
  });
}

function slotRangeLabel(slotKey: string, durationMinutes: number): string {
  const startIdx = slotKeyIndex(slotKey);
  const endIdx = startIdx + Math.max(1, Math.ceil(durationMinutes / 30));
  const startLabel = formatAvailabilitySlotLabel(startIdx);
  const endLabel = formatAvailabilitySlotLabel(Math.min(endIdx, 47));
  return `${startLabel} – ${endLabel}`;
}

export function buildRescheduleTimeOptions(args: {
  slotHosts: SlotHosts;
  dayYmd: string;
  currentStartIso: string;
  durationMinutes: number;
  preferredSlotKey?: string | null;
}): { options: RescheduleTimeOption[]; selectedSlotKey: string | null } {
  const hosts = slotHostsForReschedule(args.slotHosts, args.currentStartIso);
  const keys = openSlotKeysForDate(hosts, args.dayYmd);
  const options = keys.map((slotKey) => ({
    value: slotKey,
    slotKey,
    label: slotRangeLabel(slotKey, args.durationMinutes),
  }));
  const currentKey = slotKeyForInstant(args.currentStartIso);
  const onDay = currentKey && slotKeyDateStr(currentKey) === args.dayYmd ? currentKey : null;
  const preferred =
    (args.preferredSlotKey && keys.includes(args.preferredSlotKey) ? args.preferredSlotKey : null) ??
    (onDay && keys.includes(onDay) ? onDay : null) ??
    keys[0] ??
    null;
  return { options, selectedSlotKey: preferred };
}

export function rescheduleSlotKeyToStartIso(slotKey: string): string | null {
  return isoWindowFromSlotKey(slotKey)?.start ?? null;
}

export function formatRescheduleWhenLabel(startIso: string, durationMinutes: number): string {
  const key = slotKeyForInstant(startIso);
  if (key) return `${formatDayLabel(slotKeyDateStr(key))} · ${slotRangeLabel(key, durationMinutes)}`;
  return formatPacificDateTime(startIso);
}
