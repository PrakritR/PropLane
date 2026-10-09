/** Max rows in dashboard / summary lists inside the native app shell. */
export const PORTAL_NATIVE_LIST_PREVIEW = 3;

/** Max rows on mobile web (below `lg`) when not in the native shell. */
export const PORTAL_MOBILE_LIST_PREVIEW = 5;

export function portalListPreviewLimit(isNative: boolean | null | undefined): number {
  return isNative ? PORTAL_NATIVE_LIST_PREVIEW : PORTAL_MOBILE_LIST_PREVIEW;
}

/** Strip trailing "· 9 rooms" from property titles — redundant when scoped to one listing. */
export function stripPropertyRoomCountSuffix(label: string): string {
  return label.trim().replace(/\s*[·—–]\s*\d+\s*rooms?\s*$/i, "");
}

/**
 * Join the parts of a place line ("Applicant", "Alder Row — 3 rooms", "3 rooms") so a house
 * and its room-count suffix each appear ONCE: empty parts drop, a part that repeats an earlier
 * one (ignoring a trailing room-count suffix) drops, and a bare "3 rooms" drops when an earlier
 * part already ends in a room count.
 */
export function composePlaceLine(parts: readonly (string | null | undefined)[], separator = " · "): string {
  const kept: string[] = [];
  const keys: string[] = [];
  let hasRoomCount = false;
  for (const raw of parts) {
    const part = String(raw ?? "").trim();
    if (!part) continue;
    const key = stripPropertyRoomCountSuffix(part).toLowerCase();
    if (keys.includes(key)) continue;
    const bareCount = /^\d+\s*rooms?$/i.test(part);
    if (bareCount && hasRoomCount) continue;
    if (key !== part.toLowerCase() || bareCount) hasRoomCount = true;
    keys.push(key);
    kept.push(part);
  }
  return kept.join(separator);
}

/**
 * Compact subtitle for lease / resident rows on small screens.
 * "5259 Brooklyn Ave NE · 9 rooms · Room 8" + "$825/mo" → "Room 8 · $825/mo"
 */
/** Drop repeated " · " segments — common when property title is echoed at the end. */
export function dedupePlacementSegments(unitLabel: string): string {
  const segments = unitLabel
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length <= 1) return unitLabel.trim() || "—";

  while (
    segments.length > 1 &&
    segments[segments.length - 1]!.toLowerCase() === segments[0]!.toLowerCase()
  ) {
    segments.pop();
  }

  const deduped = segments.filter(
    (segment, index) =>
      index === 0 || segment.toLowerCase() !== segments[index - 1]!.toLowerCase(),
  );
  return deduped.join(" · ") || unitLabel.trim() || "—";
}

export function formatCompactPlacementLine(
  unitLabel: string,
  rentLabel?: string | null,
  options?: { forceCompact?: boolean },
): string {
  const rent = rentLabel?.trim() || "";
  const normalized = dedupePlacementSegments(unitLabel);
  const segments = normalized
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);

  const roomIdx = segments.findIndex((part) => /^room\b/i.test(part));
  const hasRoomCount = segments.some((part) => /^\d+\s*rooms?$/i.test(part));
  const shouldCompact =
    options?.forceCompact || (roomIdx >= 0 && segments.length >= 3 && hasRoomCount);

  if (shouldCompact && roomIdx >= 0) {
    return [segments[roomIdx], rent].filter(Boolean).join(" · ");
  }

  const base = segments.join(" · ") || normalized || "—";
  return rent ? `${base} · ${rent}` : base;
}

/** Compact charge line for dashboard previews. Omits balance when the row badge already shows it. */
export function formatCompactChargeLine(
  title: string,
  balanceLabel: string,
  dueLabel: string,
  options?: { omitBalance?: boolean },
): string {
  const charge = title.trim() || "Charge";
  const shortTitle = charge.replace(/\s*—\s*/g, " · ").replace(/\s+/g, " ").trim();
  const parts = options?.omitBalance
    ? [shortTitle, dueLabel.trim()]
    : [shortTitle, balanceLabel.trim(), dueLabel.trim()];
  return parts.filter(Boolean).join(" · ");
}

export function sliceForPortalPreview<T>(items: T[], isNative: boolean | null | undefined): {
  visible: T[];
  overflow: number;
} {
  const limit = portalListPreviewLimit(isNative);
  const visible = items.slice(0, limit);
  return { visible, overflow: Math.max(0, items.length - visible.length) };
}
