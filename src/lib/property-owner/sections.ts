/**
 * The Property owner portal surface, as pure data (client-safe).
 *
 * An owner-only account sees five rows: Overview, Properties, Money (Statements,
 * Finances for the owner of record of a managed workspace, and Documents as
 * tabs), Messages (only while the manager has it on for this owner) and
 * Settings. Everything else, in the sidebar, the phone bottom nav,
 * the More sheet, or typed into the address bar, ends up on Overview.
 *
 * The menu is NOT the security boundary: the manager APIs refuse an owner on
 * the server (`getOwnerAccessState`, the module readers' `withoutOwnerLinks`).
 */

export const OWNER_BASE_PATH = "/portal/owner";
/** Where an owner lands, and where any other section is sent. */
export const OWNER_HOME_PATH = OWNER_BASE_PATH;

/** The five rows of the owner sidebar. Money folds Statements, Finances and Documents into one row with a tab strip. */
export type OwnerSectionId = "overview" | "properties" | "money" | "messages" | "settings";

/** The tabs of the Money row, in order. Each is a real page of its own. */
export type OwnerMoneyTabId = "statements" | "finances" | "documents";

export type OwnerNavItem = { id: OwnerSectionId; label: string; href: string };
export type OwnerMoneyTab = { id: OwnerMoneyTabId; label: string; href: string };

const MONEY_TABS: readonly OwnerMoneyTab[] = [
  { id: "statements", label: "Statements", href: `${OWNER_BASE_PATH}/statements` },
  { id: "finances", label: "Finances", href: `${OWNER_BASE_PATH}/finances` },
  { id: "documents", label: "Documents", href: `${OWNER_BASE_PATH}/documents` },
];

/** Statements and Documents always; Finances only for the owner of record of a PropLane-managed workspace. */
export function ownerMoneyTabs(financesOn = false): OwnerMoneyTab[] {
  return MONEY_TABS.filter((tab) => tab.id !== "finances" || financesOn);
}

const ALL_ITEMS: readonly OwnerNavItem[] = [
  { id: "overview", label: "Overview", href: OWNER_BASE_PATH },
  { id: "properties", label: "Properties", href: `${OWNER_BASE_PATH}/properties` },
  { id: "money", label: "Money", href: `${OWNER_BASE_PATH}/statements` },
  { id: "messages", label: "Messages", href: `${OWNER_BASE_PATH}/messages` },
  { id: "settings", label: "Settings", href: `${OWNER_BASE_PATH}/profile` },
];

/** The nav, in order: at most five rows. Messages is present only while it is on for this owner. */
export function ownerNavItems(messagesOn: boolean): OwnerNavItem[] {
  return ALL_ITEMS.filter((item) => item.id !== "messages" || messagesOn);
}

/** Rows on a phone's primary bottom bar; Settings lives in the More sheet. */
export function ownerPrimaryNavItems(messagesOn: boolean): OwnerNavItem[] {
  return ownerNavItems(messagesOn).filter((item) => item.id !== "settings");
}

/** The URL head each row answers to (the segment after `/portal/owner`). */
const ROW_HEADS: Record<OwnerSectionId, readonly string[]> = {
  overview: [""],
  properties: ["properties"],
  money: ["statements", "finances", "documents"],
  messages: ["messages"],
  settings: ["profile"],
};

/** The row a path belongs to, or null for a path that is not an owner page. */
export function ownerSectionForPath(pathname: string): OwnerSectionId | null {
  const path = pathname.split("?")[0]!.replace(/\/+$/, "") || "/";
  if (path !== OWNER_BASE_PATH && !path.startsWith(`${OWNER_BASE_PATH}/`)) return null;
  const head = path.slice(OWNER_BASE_PATH.length).replace(/^\//, "").split("/")[0] ?? "";
  for (const [id, heads] of Object.entries(ROW_HEADS) as [OwnerSectionId, readonly string[]][]) {
    if (heads.includes(head)) return id;
  }
  return null;
}

/** The Money tab a path shows, or null outside Money. */
export function ownerMoneyTabForPath(pathname: string): OwnerMoneyTabId | null {
  if (ownerSectionForPath(pathname) !== "money") return null;
  const path = pathname.split("?")[0]!.replace(/\/+$/, "");
  return (path.slice(OWNER_BASE_PATH.length).replace(/^\//, "").split("/")[0] ?? "") as OwnerMoneyTabId;
}

/**
 * Whether `pathname` is a page an owner-only account may open. Only the owner
 * routes qualify; the path must be the owner base or a segment under it.
 */
export function ownerPathAllowed(pathname: string, messagesOn: boolean, financesOn = false): boolean {
  const path = pathname.split("?")[0]!.replace(/\/+$/, "") || "/";
  if (path !== OWNER_BASE_PATH && !path.startsWith(`${OWNER_BASE_PATH}/`)) return false;
  const rest = path.slice(OWNER_BASE_PATH.length).replace(/^\//, "");
  const head = rest.split("/")[0] ?? "";
  if (head === "") return true;
  if (head === "messages") return messagesOn;
  if (head === "finances") return financesOn;
  return head === "properties" || head === "statements" || head === "documents" || head === "profile";
}

/** Where an owner-only account should be sent for a path it may not open. */
export function ownerRedirectFor(pathname: string, messagesOn: boolean, financesOn = false): string | null {
  return ownerPathAllowed(pathname, messagesOn, financesOn) ? null : OWNER_HOME_PATH;
}
