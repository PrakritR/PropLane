/**
 * Pure tour slot-math shared by the public availability route and the
 * approval-first tour-proposal engine. A slotKey is `"YYYY-MM-DD:slotIndex"`
 * where slotIndex is 0-47 (48 half-hours per day, each 30 minutes). Keeping
 * this math in ONE place means the "first open slot" a proposal picks is
 * computed identically to what the public availability grid publishes.
 *
 * ## A slotKey is WALL TIME, and the wall clock is Pacific — never the server's
 *
 * `"2026-08-06:20"` means "10:00 on Aug 6" on the calendar a manager paints and
 * a guest reads, not an instant. Resolving it with `new Date(y, m, d)` reads the
 * SERVER's zone, which is Pacific in dev and **UTC on Vercel** — a seven-hour
 * error in production. Everything downstream is a silent no-op at that point:
 * `overlaps()` compares a confirmed tour against the wrong half hour, so the
 * booked slot stays on offer and a second prospect books on top of it, and
 * `slotIsBookable()` mis-judges which slots are in the past. Both were live.
 *
 * The product already renders every tour time through `formatPacificDateTime`,
 * so Pacific is the zone the whole tour surface already means. Anchor here.
 * (Known gap, deliberately not widened in this pass: the PUBLIC booking client
 * still turns the chosen slot into an instant with the PROSPECT's browser zone,
 * so an out-of-region guest sends a slotKey and an ISO that disagree. Blocking
 * survives it because a planned tour carries its `slotKey` and
 * {@link slotBlocked} matches on that first.)
 */

/** The wall clock every published slotKey is painted and read on. */
export const TOUR_CALENDAR_TIME_ZONE = "America/Los_Angeles";

export type TourBlock = {
  start: string;
  end: string;
  slotKey?: string;
};

/** Soft-canceled tours stay in the store for history but must not block slots. */
export function isActivePlannedTourEvent(event: Record<string, unknown>): boolean {
  const canceledAt = event.canceledAt;
  return !String(typeof canceledAt === "string" ? canceledAt : "").trim();
}

/** Milliseconds `timeZone` is offset from UTC at a given instant. */
function timeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value ?? "0");
  // Intl reports midnight as hour 24 in some ICU versions.
  const hour = part("hour") % 24;
  return (
    Date.UTC(part("year"), part("month") - 1, part("day"), hour, part("minute"), part("second")) - utcMs
  );
}

/** The instant a wall-clock time occurs at in {@link TOUR_CALENDAR_TIME_ZONE}. */
export function zonedWallTimeMs(
  year: number,
  month: number,
  day: number,
  minutesIntoDay: number,
  timeZone: string = TOUR_CALENDAR_TIME_ZONE,
): number {
  const naive = Date.UTC(year, month - 1, day, 0, minutesIntoDay);
  const firstGuess = naive - timeZoneOffsetMs(naive, timeZone);
  // One correction pass settles the DST-transition days, where the offset that
  // applies at the resolved instant differs from the offset at the guess.
  const settled = naive - timeZoneOffsetMs(firstGuess, timeZone);
  return settled;
}

/**
 * Instant of an ISO timestamp, reading a zone-less one as calendar wall time.
 *
 * Google returns all-day events as bare dates, and local-naive ISO strings turn
 * up in stored payloads. `Date.parse` reads those in the SERVER's zone, which
 * is the same production-only error {@link zonedWallTimeMs} exists to avoid.
 */
export function blockInstantMs(value: string): number {
  const raw = value.trim();
  if (!raw) return Number.NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return Date.parse(raw);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (!match) return Date.parse(raw);
  const [, year, month, day, hour, minute, second] = match;
  const minutesIntoDay = Number(hour ?? 0) * 60 + Number(minute ?? 0) + Number(second ?? 0) / 60;
  return zonedWallTimeMs(Number(year), Number(month), Number(day), minutesIntoDay);
}

export function safePropertyId(propertyId: string): string {
  return propertyId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

export function payloadSlots(rowData: unknown): string[] {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return [];
  const payload = (rowData as Record<string, unknown>).payload;
  return Array.isArray(payload) ? payload.filter((item): item is string => typeof item === "string") : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Unwrap a schedule record's `row_data` to the inquiry payload it carries. */
export function rowPayload(rowData: unknown): Record<string, unknown> | null {
  const row = asObject(rowData);
  if (!row) return null;
  return asObject(row.payload) ?? row;
}

/** Requested tour windows from an inquiry payload (array form or single proposed*). */
export function windowsFromPayload(payload: Record<string, unknown>): TourBlock[] {
  const requested = Array.isArray(payload.requestedWindows) ? payload.requestedWindows : [];
  const windows = requested
    .map(asObject)
    .filter((window): window is Record<string, unknown> => Boolean(window))
    .map((window) => ({
      start: textField(window, "start"),
      end: textField(window, "end"),
      slotKey: textField(window, "slotKey") || undefined,
    }))
    .filter((window) => window.start && window.end);
  if (windows.length > 0) return windows;
  const start = textField(payload, "proposedStart") || textField(payload, "start");
  const end = textField(payload, "proposedEnd") || textField(payload, "end");
  if (!start || !end) return [];
  return [{ start, end, slotKey: textField(payload, "slotKey") || undefined }];
}

export function slotStartMs(slot: string): number | null {
  const [dateStr, rawSlotIndex] = slot.split(":");
  const slotIndex = Number.parseInt(rawSlotIndex ?? "", 10);
  if (!dateStr || !Number.isFinite(slotIndex) || slotIndex < 0 || slotIndex >= 48) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return null;
  return zonedWallTimeMs(year, month, day, slotIndex * 30);
}

export function overlaps(slot: string, block: TourBlock): boolean {
  const startMs = slotStartMs(slot);
  if (startMs === null) return false;
  const endMs = startMs + 30 * 60 * 1000;
  const blockStartMs = blockInstantMs(block.start);
  const blockEndMs = blockInstantMs(block.end);
  if (![blockStartMs, blockEndMs].every(Number.isFinite)) return false;
  return startMs < blockEndMs && blockStartMs < endMs;
}

export function slotBlocked(slot: string, blocks: TourBlock[]): boolean {
  return blocks.some((block) => block.slotKey === slot || overlaps(slot, block));
}

/**
 * How much notice a manager requires before a tour, in whole days. `0` means same-day tours are
 * allowed; `3` means the soonest bookable day is three days after today.
 *
 * Deliberately CALENDAR days rather than 72 hours. A manager saying "I need three days' notice"
 * means "nothing sooner than three days from today", and hour arithmetic makes that unpredictable
 * — booking at 9am and at 11pm on the same day would offer different first days.
 */
export const TOUR_NOTICE_DAY_OPTIONS = [0, 1, 2, 3, 7] as const;
export type TourNoticeDays = (typeof TOUR_NOTICE_DAY_OPTIONS)[number];
export const DEFAULT_TOUR_NOTICE_DAYS = 0;

/** Only a whole number of days inside the offered range counts; anything else means no notice. */
export function normalizeTourNoticeDays(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TOUR_NOTICE_DAYS;
  const days = Math.floor(n);
  if (days <= 0) return 0;
  // Cap rather than reject: a stored value beyond the offered options still means "a lot of
  // notice", and silently reading it as zero would open same-day tours the manager disallowed.
  return Math.min(days, 30);
}

/**
 * The soonest Pacific calendar date a tour may be booked on, as `"YYYY-MM-DD"`.
 *
 * The day shift is done on the calendar (`Date.UTC` on the date parts), never by adding
 * `days * 86_400_000` to an instant: a DST day is 23 or 25 hours long, so instant arithmetic
 * lands on the wrong date twice a year — exactly the class of bug this module's header warns about.
 */
export function earliestBookableTourDate(
  noticeDays: number,
  now: number = Date.now(),
  timeZone: string = TOUR_CALENDAR_TIME_ZONE,
): string {
  const today = tourCalendarDateStr(now, timeZone);
  const days = normalizeTourNoticeDays(noticeDays);
  if (days === 0) return today;
  const [year, month, day] = today.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day! + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * Now-relative gate: a slot in the past can never be booked, and a slot inside the manager's
 * required notice period can never be booked either.
 *
 * `noticeDays` defaults to 0, so every existing caller keeps today-onward behaviour.
 */
export function slotIsBookable(
  slot: string,
  now: number = Date.now(),
  noticeDays: number = DEFAULT_TOUR_NOTICE_DAYS,
): boolean {
  const startMs = slotStartMs(slot);
  if (startMs === null) return false;
  if (startMs < now) return false;
  const days = normalizeTourNoticeDays(noticeDays);
  if (days === 0) return true;
  // A slotKey's date part is already the Pacific wall date, so this compares like with like —
  // and ISO dates order lexicographically, so no Date is constructed from the slot.
  const slotDate = slot.slice(0, slot.indexOf(":"));
  return slotDate >= earliestBookableTourDate(days, now, TOUR_CALENDAR_TIME_ZONE);
}

/* -------------------------------------------------------------------------- */
/* Default offering — what a property shows before its manager publishes a week */
/* -------------------------------------------------------------------------- */

/** First default window starts 9:00 am (slot 18). */
export const DEFAULT_TOUR_START_SLOT = 18;
/** Last default window starts 4:30 pm (slot 33) and ends at 5:00 pm — a 9-to-5 day. */
export const DEFAULT_TOUR_END_SLOT_EXCLUSIVE = 34;
/**
 * How far ahead the default grid is offered. Bounds the public payload: the
 * availability response is deliberately `no-store`, so every request pays for
 * the whole grid. 60 days × 16 windows was ~960 slot entries per request; three
 * weeks is ample for a booking page and costs a third of the egress.
 */
export const DEFAULT_TOUR_HORIZON_DAYS = 21;

/** Stored availability keys that begin with this prefix exclude one default window. */
export const DEFAULT_TOUR_SLOT_EXCLUSION_PREFIX = "!";

export type DefaultTourAvailabilityConfig = {
  startSlot: number;
  endSlotExclusive: number;
  horizonDays: number;
  /** When false, an empty calendar offers no implicit default grid. */
  enabled?: boolean;
};

export function resolveDefaultTourAvailabilityConfig(
  partial?: Partial<DefaultTourAvailabilityConfig>,
): DefaultTourAvailabilityConfig {
  const startSlot = Math.max(
    0,
    Math.min(
      47,
      typeof partial?.startSlot === "number" && Number.isFinite(partial.startSlot)
        ? Math.trunc(partial.startSlot)
        : DEFAULT_TOUR_START_SLOT,
    ),
  );
  const endRaw =
    typeof partial?.endSlotExclusive === "number" && Number.isFinite(partial.endSlotExclusive)
      ? Math.trunc(partial.endSlotExclusive)
      : DEFAULT_TOUR_END_SLOT_EXCLUSIVE;
  const endSlotExclusive = Math.max(startSlot + 1, Math.min(48, endRaw));
  const horizonDays =
    typeof partial?.horizonDays === "number" && Number.isFinite(partial.horizonDays)
      ? Math.max(7, Math.min(60, Math.trunc(partial.horizonDays)))
      : DEFAULT_TOUR_HORIZON_DAYS;
  const enabled = partial?.enabled === true;
  return { startSlot, endSlotExclusive, horizonDays, enabled };
}

const DATE_SLOT_KEY_RE = /^\d{4}-\d{2}-\d{2}:\d+$/;

export function isDefaultTourSlotExclusionKey(key: string): boolean {
  return key.startsWith(DEFAULT_TOUR_SLOT_EXCLUSION_PREFIX);
}

export function defaultTourSlotExclusionKey(dateStr: string, slotIdx: number): string {
  return `${DEFAULT_TOUR_SLOT_EXCLUSION_PREFIX}${dateStr}:${slotIdx}`;
}

export function parseDefaultTourSlotExclusionKey(key: string): string | null {
  if (!isDefaultTourSlotExclusionKey(key)) return null;
  const slotKey = key.slice(DEFAULT_TOUR_SLOT_EXCLUSION_PREFIX.length);
  return DATE_SLOT_KEY_RE.test(slotKey) ? slotKey : null;
}

/** Split stored availability payload keys into painted slots and default exclusions. */
export function partitionTourAvailabilityStoredKeys(keys: readonly string[]): {
  publishedSlots: string[];
  defaultExcludedSlots: string[];
} {
  const publishedSlots: string[] = [];
  const defaultExcludedSlots: string[] = [];
  for (const key of keys) {
    if (isDefaultTourSlotExclusionKey(key)) {
      const slotKey = parseDefaultTourSlotExclusionKey(key);
      if (slotKey) defaultExcludedSlots.push(slotKey);
      continue;
    }
    if (DATE_SLOT_KEY_RE.test(key)) publishedSlots.push(key);
  }
  return { publishedSlots, defaultExcludedSlots };
}

/** `YYYY-MM-DD` for an instant, on the tour calendar's wall clock. */
export function tourCalendarDateStr(ms: number, timeZone: string = TOUR_CALENDAR_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * Should a property fall back to {@link buildDefaultTourSlotKeys}?
 *
 * The rule is "no FUTURE slot is published". A manager who painted a week that
 * has since passed gets the default rather than a dead booking page, which is
 * the point.
 *
 * The sharp edge, stated plainly: a manager who deliberately clears their
 * ENTIRE calendar — "Clear week" over every published week — has it silently
 * reopened to the public at 9-5, which could send a stranger to a property when
 * nobody is there. That risk was accepted knowingly, so it lives here rather
 * than buried in a route expression.
 *
 * Switching to the stricter rule — offer the default only when the manager has
 * NEVER published anything — is a one-line change at this predicate: take the
 * count of availability ROWS instead of future slots, and return true only when
 * no row exists.
 */
export function shouldOfferDefaultTourGrid(publishedFutureSlots: readonly string[]): boolean {
  return publishedFutureSlots.length === 0;
}

/**
 * Published availability merged with the 9-5 default on any horizon day that
 * has no future published window of its own.
 *
 * A manager who paints one week still leaves the other weeks bookable at the
 * default rather than showing a dead page. A day that already carries even one
 * future published slot keeps only what was painted — the default never fills
 * in around a partial day.
 */
export function resolveTourOfferingSlots(
  storedSlots: readonly string[],
  now: number = Date.now(),
  defaultConfig: DefaultTourAvailabilityConfig = resolveDefaultTourAvailabilityConfig(),
): string[] {
  const { publishedSlots, defaultExcludedSlots } = partitionTourAvailabilityStoredKeys(storedSlots);
  const bookablePublished = publishedSlots.filter((slot) => slotIsBookable(slot, now));
  if (defaultConfig.enabled === false) {
    return bookablePublished;
  }
  const excluded = new Set(defaultExcludedSlots);
  const datesWithPublished = new Set(
    bookablePublished.map((slot) => slot.split(":")[0]).filter((date): date is string => Boolean(date)),
  );
  const merged = new Set<string>(bookablePublished);
  for (const key of buildDefaultTourSlotKeys(now, defaultConfig.horizonDays, defaultConfig)) {
    const date = key.split(":")[0];
    if (date && !datesWithPublished.has(date) && !excluded.has(key)) {
      merged.add(key);
    }
  }
  return [...merged];
}

/**
 * The 9 am - 5 pm grid a property offers when its manager has published no
 * availability of their own.
 *
 * This is a DEFAULT, not an invention of open time: a manager who paints a week
 * replaces it entirely, and every caller still subtracts calendar-busy time and
 * already-booked slots from whatever base set it gets. Without it a property
 * whose manager has not opened the calendar yet offers a prospect nothing at
 * all, which reads as a dead booking page.
 */
/**
 * The 9-5 default windows for ONE calendar date.
 *
 * The manager calendar needs this to turn an implicit default day into explicit
 * availability: painting anything on a day switches that day off the default
 * (see {@link resolveTourOfferingSlots}), so removing a single default window
 * has to write the rest of that day back explicitly — otherwise dropping one
 * slot would silently close the whole day to prospects.
 */
export function defaultTourSlotKeysForDate(
  dateStr: string,
  defaultConfig: DefaultTourAvailabilityConfig = resolveDefaultTourAvailabilityConfig(),
): string[] {
  const keys: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return keys;
  for (let slot = defaultConfig.startSlot; slot < defaultConfig.endSlotExclusive; slot += 1) {
    keys.push(`${dateStr}:${slot}`);
  }
  return keys;
}

/**
 * Paint one explicit slot from the manager calendar.
 *
 * The first explicit slot on a day that was still on the implicit default must
 * Removing one default window stores a `!date:slot` exclusion marker so the rest
 * of the day stays on the implicit default without painting every other window.
 */
export function addExplicitTourSlotKeys(
  storedKeys: readonly string[],
  dateStr: string,
  slotIdx: number,
  defaultConfig: DefaultTourAvailabilityConfig = resolveDefaultTourAvailabilityConfig(),
  now: number = Date.now(),
): string[] {
  const key = `${dateStr}:${slotIdx}`;
  const { publishedSlots, defaultExcludedSlots } = partitionTourAvailabilityStoredKeys(storedKeys);
  const next = new Set(storedKeys);
  const excludedOnDate = defaultExcludedSlots.filter((slot) => slot.startsWith(`${dateStr}:`));
  const hasExplicitOnDate = publishedSlots.some(
    (slot) => slot.startsWith(`${dateStr}:`) && slotIsBookable(slot, now),
  );
  if (!hasExplicitOnDate) {
    for (const defaultKey of defaultTourSlotKeysForDate(dateStr, defaultConfig)) {
      if (slotIsBookable(defaultKey, now)) next.add(defaultKey);
    }
    for (const excludedSlot of excludedOnDate) {
      const match = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(excludedSlot);
      if (match) next.delete(defaultTourSlotExclusionKey(match[1], Number(match[2])));
    }
  }
  next.add(key);
  next.delete(defaultTourSlotExclusionKey(dateStr, slotIdx));
  return [...next];
}

export function buildDefaultTourSlotKeys(
  now: number = Date.now(),
  days: number = DEFAULT_TOUR_HORIZON_DAYS,
  defaultConfig?: Partial<DefaultTourAvailabilityConfig>,
): string[] {
  const resolved = resolveDefaultTourAvailabilityConfig({
    ...defaultConfig,
    horizonDays: days,
  });
  const keys: string[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const [year, month, day] = tourCalendarDateStr(now).split("-").map(Number);
  if (!year || !month || !day) return keys;
  // Anchor on local NOON and step whole days from there, so a DST transition
  // (a 23- or 25-hour day) can never skip or repeat a calendar date. Today is
  // included; its already-past windows drop out at `slotIsBookable`.
  const noonToday = zonedWallTimeMs(year, month, day, 12 * 60);
  for (let offset = 0; offset < resolved.horizonDays; offset += 1) {
    const dateStr = tourCalendarDateStr(noonToday + offset * dayMs);
    for (let slot = resolved.startSlot; slot < resolved.endSlotExclusive; slot += 1) {
      keys.push(`${dateStr}:${slot}`);
    }
  }
  return keys;
}
