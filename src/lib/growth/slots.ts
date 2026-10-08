import type { GrowthFormat, GrowthPlatform } from "./types";

const TZ = "America/Los_Angeles";

/** Default slot (PT wall clock) for a post, per the doc's cadence. */
export function defaultSlot(format: GrowthFormat, platforms: GrowthPlatform[]): { h: number; m: number } {
  if (format === "reel") return { h: 9, m: 0 };
  if (format === "carousel" || format === "image") return { h: 17, m: 0 };
  return platforms.includes("linkedin") ? { h: 8, m: 0 } : { h: 12, m: 30 };
}

function ptParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
}

/** The UTC instant for a PT wall-clock time on the given PT calendar date. */
export function ptToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = ptParts(new Date(guess));
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return new Date(guess);
}

/** Next default slot strictly after `now` that no other scheduled post already holds (to the minute). */
export function nextFreeSlot(now: Date, format: GrowthFormat, platforms: GrowthPlatform[], taken: string[]): Date {
  const { h, m } = defaultSlot(format, platforms);
  const takenMs = new Set(taken.map((t) => Math.floor(new Date(t).getTime() / 60_000)));
  const p = ptParts(now);
  for (let add = 0; add < 120; add++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + add, 12));
    const slot = ptToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m);
    if (slot.getTime() > now.getTime() && !takenMs.has(Math.floor(slot.getTime() / 60_000))) return slot;
  }
  throw new Error("No free slot in the next 120 days");
}
