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

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

/**
 * Pull a concrete calendar date out of availability copy. Understands the
 * builder's own phrasing ("Available after Oct 1, 2099", "Available from
 * 10/01/2099", "Available on Oct 1") and bare "<Mon> <d>[, <yyyy>]" / "m/d[/y]".
 * A month name with no day ("after December") is NOT a date — it stays undated.
 * A day with no year means the next time that day comes around.
 */
export function parseAvailabilityDate(raw: string): Date | null {
  const text = raw.trim();
  if (!text) return null;
  const fragment = text
    .replace(/^available\s*(?:(?:after|from|on|starting)\s+)?/i, "")
    .replace(/^(?:after|from|on|starting)\s+/i, "")
    .trim();
  if (!fragment) return null;
  const today = startOfLocalToday();

  const named = fragment.match(new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, "i"));
  if (named) {
    const month = new Date(`${named[1]} 1, 2000`).getMonth();
    const day = Number(named[2]);
    if (Number.isFinite(month) && day >= 1 && day <= 31) {
      if (named[3]) return startOfLocalDay(new Date(Number(named[3]), month, day));
      let d = new Date(today.getFullYear(), month, day);
      if (d.getTime() < today.getTime()) d = new Date(today.getFullYear() + 1, month, day);
      return startOfLocalDay(d);
    }
  }
  const numeric = fragment.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      if (numeric[3]) {
        const y = Number(numeric[3]);
        return startOfLocalDay(new Date(y < 100 ? 2000 + y : y, month, day));
      }
      let d = new Date(today.getFullYear(), month, day);
      if (d.getTime() < today.getTime()) d = new Date(today.getFullYear() + 1, month, day);
      return startOfLocalDay(d);
    }
  }
  // Anything else the platform can parse unambiguously (ISO dates, "October 1 2099").
  if (/\d{4}/.test(fragment)) {
    const d = new Date(fragment);
    if (!Number.isNaN(d.getTime())) return startOfLocalDay(d);
  }
  return null;
}

/**
 * The one reading of a room's availability copy that the browse card, the
 * detail tiles and the traffic-light pills all share, so a room can never be
 * "Available now" on one surface and "Oct 1" on another.
 *
 * - `unavailable`: leased / not available / no longer available.
 * - `now`: "Available now [until …]", "immediately", a dated opening that has
 *   already passed, or plain "Available".
 * - `later`: a dated opening still ahead (`date` set), or undated future text
 *   such as "Waitlist" / "Available soon" / "Available after December".
 * - `unknown`: copy that says nothing about availability.
 */
export type RoomOpening = { kind: "now" | "later" | "unavailable" | "unknown"; date: Date | null };

export function classifyRoomOpening(raw: string): RoomOpening {
  const text = raw.trim();
  const t = text.toLowerCase();
  if (!t) return { kind: "unknown", date: null };
  if (/\bunavailable\b|not available|no longer available|not open\b|fully booked|\bleased\b|\boccupied\b/.test(t)) {
    return { kind: "unavailable", date: null };
  }
  // "Available now until Sept 19" is a room you can move into today; the date is when it ends.
  if (/\bavailable\s+now\b|^now$|\bimmediately\b/.test(t)) return { kind: "now", date: null };
  const date = parseAvailabilityDate(text);
  if (date) {
    return startOfLocalToday().getTime() >= date.getTime() ? { kind: "now", date: null } : { kind: "later", date };
  }
  if (/available\s+(after|from|on|starting)\b|\bwaitlist\b|\bavailable soon\b/.test(t)) return { kind: "later", date: null };
  if (/^available\s*$/.test(t) || (t.includes("available") && !t.includes("after"))) return { kind: "now", date: null };
  return { kind: "unknown", date: null };
}

/**
 * Map listing copy to a display tone. Unavailable / not open = red; open now = green;
 * a dated or undated future opening = yellow; copy that says nothing = neutral.
 */
export function roomAvailabilityTone(text: string): RoomAvailabilityTone {
  const { kind } = classifyRoomOpening(text);
  if (kind === "unavailable") return "unavailable";
  if (kind === "now") return "available";
  if (kind === "later") return "future";
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

/**
 * The opening a renter should hear about first: a room open now, else the
 * earliest dated opening, else the first undated future text. Returns the
 * original wording so the tile says what the manager wrote.
 */
export function earliestRoomOpening(openings: string[]): string | null {
  let best: string | null = null;
  let bestRank = Infinity;
  for (const raw of openings) {
    const text = raw.trim();
    if (!text || text === "—") continue;
    const opening = classifyRoomOpening(text);
    if (opening.kind === "unavailable") continue;
    const rank =
      opening.kind === "now"
        ? -1
        : opening.date
          ? opening.date.getTime()
          : Number.MAX_SAFE_INTEGER;
    if (best === null || rank < bestRank) {
      best = text;
      bestRank = rank;
    }
  }
  return best;
}
