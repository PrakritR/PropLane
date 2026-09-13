/** Max rows in dashboard / summary lists inside the native app shell. */
export const PORTAL_NATIVE_LIST_PREVIEW = 3;

/** Max rows on mobile web (below `lg`) when not in the native shell. */
export const PORTAL_MOBILE_LIST_PREVIEW = 5;

export function portalListPreviewLimit(isNative: boolean | null | undefined): number {
  return isNative ? PORTAL_NATIVE_LIST_PREVIEW : PORTAL_MOBILE_LIST_PREVIEW;
}

/** Strip trailing "· 9 rooms" from property titles — redundant when scoped to one listing. */
export function stripPropertyRoomCountSuffix(label: string): string {
  return label.trim().replace(/\s*·\s*\d+\s*rooms?\s*$/i, "");
}

/**
 * Compact subtitle for lease / resident rows on small screens.
 * "5259 Brooklyn Ave NE · 9 rooms · Room 8" + "$825/mo" → "Room 8 · $825/mo"
 */
export function formatCompactPlacementLine(
  unitLabel: string,
  rentLabel?: string | null,
  options?: { forceCompact?: boolean },
): string {
  const rent = rentLabel?.trim() || "";
  const segments = unitLabel
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

  const base = segments.join(" · ") || unitLabel.trim() || "—";
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
