/**
 * Classify manager / listing room availability copy for traffic-light UI:
 * green = available now (or on/after the "available after" date), red = not available, yellow = future-dated opening.
 */

export type RoomAvailabilityTone = "available" | "unavailable" | "future" | "neutral";

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfLocalToday(): Date {
  return startOfLocalDay(new Date());
}

function parseAfterDateFragment(fragment: string): Date | null {
  const t = fragment.trim();
  if (!t) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return startOfLocalDay(d);
}

/**
 * Map listing copy to a display tone. Unavailable / not open = red; open now = green;
 * "available after" still in the future = yellow; past that date = green.
 */
export function roomAvailabilityTone(text: string): RoomAvailabilityTone {
  const raw = text.trim();
  const t = raw.toLowerCase();

  if (/\bunavailable\b|not available|signed.*not available|no longer available|not open\b/.test(t)) {
    return "unavailable";
  }

  const after = raw.match(/available\s+after\s+(.+)/i);
  if (after) {
    const d = parseAfterDateFragment(after[1]!);
    if (d) {
      return startOfLocalToday().getTime() >= d.getTime() ? "available" : "future";
    }
    return "future";
  }

  if (/\bwaitlist\b|\bavailable soon\b/i.test(raw)) return "future";

  if (/\bavailable now\b/i.test(raw)) return "available";

  if (/^available\s*$/i.test(raw)) return "available";

  if (t.includes("available") && !t.includes("after") && !t.includes("un")) return "available";

  return "neutral";
}

export function roomAvailabilityPillClasses(tone: RoomAvailabilityTone): { wrap: string; dot: string } {
  const ring = "ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  switch (tone) {
    case "available":
      return {
        wrap: `portal-badge-success ${ring}`,
        dot: "bg-emerald-500",
      };
    case "unavailable":
      return {
        wrap: `portal-badge-danger ${ring}`,
        dot: "bg-rose-500",
      };
    case "future":
      return {
        wrap: `portal-badge-pending ${ring}`,
        dot: "bg-amber-500",
      };
    default:
      return {
        wrap: `border border-border bg-accent/35 text-foreground ${ring}`,
        dot: "bg-muted",
      };
  }
}

/** Text color classes for plain availability lines (search cards). */
export function roomAvailabilityTextClasses(tone: RoomAvailabilityTone): string {
  switch (tone) {
    case "available":
      return "text-[var(--status-confirmed-fg)]";
    case "unavailable":
      return "text-[var(--status-overdue-fg)]";
    case "future":
      return "text-[var(--status-pending-fg)]";
    default:
      return "text-muted";
  }
}

export function earliestRoomOpening(openings: string[]): string | null {
  let earliest: string | null = null;
  let earliestTime = Infinity;
  for (const raw of openings) {
    const text = raw.trim();
    if (!text || text === "—") continue;
    const fragment = text.replace(/^available\s+(?:(?:after|from|on|starting)\s+)?/i, "");
    const parsed = Date.parse(fragment);
    const time = Number.isFinite(parsed) ? parsed : Infinity;
    if (earliest === null || time < earliestTime) {
      earliest = text;
      earliestTime = time;
    }
  }
  return earliest;
}
