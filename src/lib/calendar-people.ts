/**
 * "Who is doing what" on the shared Calendar: one stable colour per person, the
 * pale availability blocks a person's open hours draw, and the people row that
 * toggles whose time is on screen.
 *
 * Pure: nothing here reads storage or React. The panel hands in the peers it got
 * from `/api/portal/co-manager-calendar` and the viewer's own slot sets.
 */
import type { AvailabilityKind } from "@/lib/manager-availability-kinds";
import { AVAILABILITY_KIND_LABELS } from "@/lib/manager-availability-kinds";
import { partitionTourAvailabilityStoredKeys } from "@/lib/tour-slot-math";

/** The validated categorical order. A sixth person reuses a colour and is told apart by initials. */
export const PERSON_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"] as const;

const SLOT_MINUTES = 30;
const DATE_SLOT_RE = /^(\d{4}-\d{2}-\d{2}):(\d{1,2})$/;

export type CalendarPerson = {
  userId: string;
  label: string;
  isSelf: boolean;
  initials: string;
  color: string;
};

/** Two letters from a name ("Maya Chen" -> "MC"), one from a single word, "?" from nothing. */
export function personInitials(label: string): string {
  const words = label
    .replace(/\(.*?\)/g, " ")
    .split(/[\s._@-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]!.charAt(0)}${words[words.length - 1]!.charAt(0)}`.toUpperCase();
}

/**
 * A colour per person from their position in the user-id sort. It depends only on
 * who is on the house, never on who is currently shown, so hiding a person in the
 * people row never repaints the others.
 */
export function assignPersonColors(userIds: readonly string[]): Map<string, string> {
  const sorted = [...new Set(userIds.map((id) => id.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return new Map(sorted.map((id, index) => [id, PERSON_COLORS[index % PERSON_COLORS.length]!]));
}

/** The people row's order: you first, then everyone else by name. Colours come from the full set. */
export function buildCalendarPeople(
  peers: ReadonlyArray<{ userId: string; label: string; isSelf: boolean }>,
): CalendarPerson[] {
  const colors = assignPersonColors(peers.map((peer) => peer.userId));
  return [...peers]
    .map((peer) => ({
      userId: peer.userId,
      label: peer.label,
      isSelf: peer.isSelf,
      initials: personInitials(peer.isSelf ? "You" : peer.label),
      color: colors.get(peer.userId.trim()) ?? PERSON_COLORS[0],
    }))
    .sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });
}

/** Pale availability: 12% tint, 45% border. Text stays in the ink token. */
export function personAvailabilityStyle(color: string): { background: string; borderColor: string } {
  return {
    background: `color-mix(in srgb, ${color} 12%, var(--card))`,
    borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
  };
}

export type PersonAvailabilityBlock = {
  id: string;
  userId: string;
  kind: AvailabilityKind;
  dateStr: string;
  startMin: number;
  endMin: number;
};

/**
 * One person's open hours of one kind as contiguous blocks per date. Slot keys are
 * `YYYY-MM-DD:slot` (half hours); tour slot sets also carry default-window markers,
 * which are dropped here: only published windows draw.
 */
export function personAvailabilityBlocks(args: {
  userId: string;
  kind: AvailabilityKind;
  slots: Iterable<string>;
  dateStrs: readonly string[];
}): PersonAvailabilityBlock[] {
  const wanted = new Set(args.dateStrs);
  const byDate = new Map<string, number[]>();
  for (const key of partitionTourAvailabilityStoredKeys([...args.slots]).publishedSlots) {
    const match = DATE_SLOT_RE.exec(key);
    if (!match || !wanted.has(match[1]!)) continue;
    const slot = Number(match[2]);
    if (!Number.isFinite(slot) || slot < 0 || slot > 47) continue;
    const list = byDate.get(match[1]!) ?? [];
    list.push(slot);
    byDate.set(match[1]!, list);
  }
  const out: PersonAvailabilityBlock[] = [];
  for (const dateStr of args.dateStrs) {
    const slots = [...new Set(byDate.get(dateStr) ?? [])].sort((a, b) => a - b);
    let start: number | null = null;
    let prev = -2;
    const flush = () => {
      if (start === null) return;
      out.push({
        id: `avail-${args.userId}-${args.kind}-${dateStr}-${start}`,
        userId: args.userId,
        kind: args.kind,
        dateStr,
        startMin: start * SLOT_MINUTES,
        endMin: (prev + 1) * SLOT_MINUTES,
      });
      start = null;
    };
    for (const slot of slots) {
      if (start !== null && slot !== prev + 1) flush();
      if (start === null) start = slot;
      prev = slot;
    }
    flush();
  }
  return out;
}

export function personAvailabilityLabel(kind: AvailabilityKind): string {
  return AVAILABILITY_KIND_LABELS[kind];
}

/** Which kinds a peer's availability can be read for: services and tasks come from the kind record. */
export type PeerKindSlots = { services: readonly string[]; tasks: readonly string[] };

/** All of one person's availability blocks across the kinds, in a fixed order. */
export function peerAvailabilityBlocks(args: {
  userId: string;
  toursSlots: Iterable<string>;
  kindSlots?: PeerKindSlots | null;
  dateStrs: readonly string[];
}): PersonAvailabilityBlock[] {
  const { userId, dateStrs } = args;
  return [
    ...personAvailabilityBlocks({ userId, kind: "tours", slots: args.toursSlots, dateStrs }),
    ...personAvailabilityBlocks({ userId, kind: "services", slots: args.kindSlots?.services ?? [], dateStrs }),
    ...personAvailabilityBlocks({ userId, kind: "tasks", slots: args.kindSlots?.tasks ?? [], dateStrs }),
  ];
}

function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 0;
  const value = Number.parseInt(match[1]!, 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

export const PERSON_LIGHT_INK = "#ffffff";
export const PERSON_DARK_INK = "#0f172a";

/** WCAG contrast ratio of two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** White on a solid person block unless the person's colour is light enough that the ink token reads better. */
export function inkOnPersonColor(color: string): string {
  return contrastRatio(color, PERSON_LIGHT_INK) >= contrastRatio(color, PERSON_DARK_INK)
    ? PERSON_LIGHT_INK
    : PERSON_DARK_INK;
}

export type OpenTourHost = {
  userId: string;
  /** Half-hour keys (`YYYY-MM-DD:slot`) this person offers for tours. */
  offered: ReadonlySet<string>;
  /** Half-hour keys this person is already busy in. */
  busy: ReadonlySet<string>;
};

/**
 * The tour slots still open at a house: a slot is open while at least one available person offers
 * it and is not busy then. This is the client half of `listOpenTourSlots`, so the "N open" count
 * agrees with what the booking page can place.
 */
export function openTourSlotKeys(hosts: readonly OpenTourHost[]): Set<string> {
  const open = new Set<string>();
  for (const host of hosts) {
    for (const key of host.offered) {
      if (!host.busy.has(key)) open.add(key);
    }
  }
  return open;
}
