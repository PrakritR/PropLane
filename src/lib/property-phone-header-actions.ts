import type { PortalAdaptiveAction } from "@/lib/portal-adaptive-actions";

/** The one icon a phone keeps in the property header: Edit (a draft's Edit is "continue-draft"). */
const PHONE_PRIMARY_IDS = ["edit-listing", "continue-draft"] as const;

/**
 * A property's header on a phone: Edit stays, everything else (Share, Unlist,
 * Duplicate, Delete) folds into one ⋯ menu so the name sits on one line and the
 * address shows. A header with no Edit (a read-only co-manager) is only the
 * ⋯ menu. `extra` is a menu-only entry that exists only on a
 * phone (the preview's Email, which the slim sticky bar gave up), placed after
 * the first menu item.
 *
 * Pure so the collapse rule is testable without a DOM; the desktop header is
 * the adaptive row and never calls this ("header actions reach a phone exactly
 * once": the phone renders this, wider widths render the row, never both).
 */
export function splitPropertyPhoneHeaderActions(
  actions: PortalAdaptiveAction[],
  extra?: PortalAdaptiveAction | null,
): { primary: PortalAdaptiveAction | null; menu: PortalAdaptiveAction[] } {
  const primary =
    actions.find((action) => (PHONE_PRIMARY_IDS as readonly string[]).includes(action.id)) ?? null;
  const menu = actions.filter((action) => action !== primary);
  if (extra) menu.splice(Math.min(1, menu.length), 0, extra);
  return { primary, menu };
}
