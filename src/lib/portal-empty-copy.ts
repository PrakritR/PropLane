/**
 * What every empty manager list tab says (PLAN-0914-1629).
 *
 * One card everywhere — glyph tile · title · sibling link · pill — and one
 * table of titles, so a copy fix is one line and no tab can drift back to
 * "Nothing here yet". Titles name the tab ("No tours pending", "Nothing
 * unlisted"); there is deliberately no sentence under them.
 */

export type PortalEmptyCopy = {
  title: string;
  /** The sidebar section whose glyph fills the tile (see `PortalNavIcon`). */
  section: string;
};

const T = (title: string, section: string): PortalEmptyCopy => ({ title, section });

/** section · tab → title + glyph. Keys are the route segments the tabs use. */
export const PORTAL_EMPTY_COPY = {
  "properties.all": T("No homes yet", "properties"),
  "properties.listed": T("Nothing listed", "properties"),
  "properties.unlisted": T("Nothing unlisted", "properties"),
  "properties.drafts": T("No drafts", "properties"),
  "tours.pending": T("No tours pending", "tours"),
  "tours.upcoming": T("Nothing upcoming", "tours"),
  "tours.past": T("No past tours", "tours"),
  "applications.incomplete": T("No incomplete applications", "applications"),
  "applications.pending": T("No applications pending", "applications"),
  "applications.approved": T("Nothing approved yet", "applications"),
  "applications.rejected": T("Nothing rejected", "applications"),
  "leases.manager": T("Nothing to review", "leases"),
  "leases.resident": T("Nothing awaiting the resident", "leases"),
  "leases.signed": T("Nothing for you to sign", "leases"),
  "leases.completed": T("No signed leases", "leases"),
  "residents.potential": T("No potential residents", "residents"),
  "residents.current": T("No current residents", "residents"),
  "residents.past": T("No past residents", "residents"),
  "inspections.move-in": T("No move-in inspections", "inspections"),
  "inspections.move-out": T("No move-out inspections", "inspections"),
  "payments.pending": T("Nothing pending", "payments"),
  "payments.overdue": T("Nothing overdue", "payments"),
  "payments.paid": T("Nothing paid yet", "payments"),
  "payments.outgoing": T("No payments out", "payments"),
  "services.open": T("No open services", "services"),
  "services.scheduled": T("Nothing scheduled", "services"),
  "services.done": T("Nothing done yet", "services"),
  "services.declined": T("Nothing declined", "services"),
  vendors: T("No vendors yet", "vendors"),
  "vendors.catalog": T("No PropLane vendors", "vendors"),
  "tasks.open": T("No open tasks", "tasks"),
  "tasks.overdue": T("Nothing overdue", "tasks"),
  "tasks.completed": T("Nothing done yet", "tasks"),
  "bookings.upcoming": T("No upcoming bookings", "bookings"),
  "bookings.inhouse": T("No one in-house", "bookings"),
  "bookings.past": T("No past bookings", "bookings"),
  "communication.active": T("No conversations yet", "communication"),
  "communication.unread": T("All caught up", "communication"),
  "communication.archived": T("Nothing archived", "communication"),
  promotion: T("No promotions yet", "promotion"),
  "promotion.text": T("No text promotions yet", "promotion"),
  "promotion.image": T("No image promotions yet", "promotion"),
  "calendar.all": T("Nothing this week", "calendar"),
  "calendar.tours": T("No tours this week", "calendar"),
  "calendar.services": T("No services this week", "calendar"),
  "calendar.tasks": T("No tasks due this week", "calendar"),
  "finances.income": T("No income yet", "financials"),
  "finances.expenses": T("No expenses yet", "financials"),
  "documents.applications": T("No application documents yet", "documents"),
  "documents.leases": T("No lease documents yet", "documents"),
  "documents.other": T("No documents yet", "documents"),
} as const satisfies Record<string, PortalEmptyCopy>;

export type PortalEmptyCopyKey = keyof typeof PORTAL_EMPTY_COPY;

export function portalEmptyCopy(key: PortalEmptyCopyKey): PortalEmptyCopy {
  return PORTAL_EMPTY_COPY[key];
}

/** "No homes match “paseo”" / "No homes match these filters" — the muted no-match card. */
export function portalEmptyNoMatchTitle(noun: string, query?: string): string {
  const q = query?.trim();
  return q ? `No ${noun} match “${q}”` : `No ${noun} match these filters`;
}

export type PortalEmptySiblingTab = {
  id: string;
  label: string;
  count?: number;
  /** Routed tabs link; local-state tabs (Services) switch in place. */
  href?: string;
  onSelect?: () => void;
};

/**
 * The sibling link: the first OTHER tab that has rows — "3 approved →". Null
 * when no sibling has anything, so the card shows nothing rather than "0 …".
 */
export function portalEmptySibling(
  tabs: readonly PortalEmptySiblingTab[],
  activeId: string,
): { label: string; href?: string; onClick?: () => void } | null {
  for (const tab of tabs) {
    if (tab.id === activeId || (!tab.href && !tab.onSelect)) continue;
    const n = tab.count ?? 0;
    if (n <= 0) continue;
    return { label: `${n} ${tab.label.trim().toLowerCase()}`, href: tab.href, onClick: tab.onSelect };
  }
  return null;
}

/**
 * A title for a list that reaches the shared surface with only an add label —
 * "Add lease" → "No leases yet". Manager tabs never rely on this (they pass a
 * card from the table); it keeps embedded and other-portal lists off the old
 * "Nothing here yet".
 */
export function portalEmptyTitleFromAddLabel(label: string): string {
  const noun = label
    .trim()
    .replace(/^(add|new|create|schedule|upload|invite|log|record)\s+(a\s+|an\s+)?/i, "")
    .replace(/\s+(for|to)\s+.*$/i, "")
    .trim()
    .toLowerCase();
  if (!noun) return "Nothing yet";
  const plural = /(s|x|ch|sh)$/i.test(noun) ? `${noun}es` : /[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `No ${plural} yet`;
}
