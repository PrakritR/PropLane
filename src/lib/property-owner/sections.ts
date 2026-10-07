/**
 * The Property owner portal surface, as pure data (client-safe).
 *
 * An owner-only account sees exactly these sections: Overview, Properties,
 * Statements, Documents, Messages (only while the manager has it on for this
 * owner) and Profile. Everything else, in the sidebar, the phone bottom nav,
 * the More sheet, or typed into the address bar, ends up on Overview.
 *
 * The menu is NOT the security boundary: the manager APIs refuse an owner on
 * the server (`getOwnerAccessState`, the module readers' `withoutOwnerLinks`).
 */

export const OWNER_BASE_PATH = "/portal/owner";
/** Where an owner lands, and where any other section is sent. */
export const OWNER_HOME_PATH = OWNER_BASE_PATH;

export type OwnerSectionId = "overview" | "properties" | "statements" | "documents" | "messages" | "profile";

export type OwnerNavItem = { id: OwnerSectionId; label: string; href: string };

const ALL_ITEMS: readonly OwnerNavItem[] = [
  { id: "overview", label: "Overview", href: OWNER_BASE_PATH },
  { id: "properties", label: "Properties", href: `${OWNER_BASE_PATH}/properties` },
  { id: "statements", label: "Statements", href: `${OWNER_BASE_PATH}/statements` },
  { id: "documents", label: "Documents", href: `${OWNER_BASE_PATH}/documents` },
  { id: "messages", label: "Messages", href: `${OWNER_BASE_PATH}/messages` },
  { id: "profile", label: "Profile", href: `${OWNER_BASE_PATH}/profile` },
];

/** The nav, in order. Messages is present only while it is on for this owner. */
export function ownerNavItems(messagesOn: boolean): OwnerNavItem[] {
  return ALL_ITEMS.filter((item) => item.id !== "messages" || messagesOn);
}

/** Sections that move to a phone's primary bottom bar; Profile lives in the More sheet. */
export function ownerPrimaryNavItems(messagesOn: boolean): OwnerNavItem[] {
  return ownerNavItems(messagesOn).filter((item) => item.id !== "profile");
}

/**
 * Whether `pathname` is a page an owner-only account may open. Only the owner
 * routes qualify; the path must be the owner base or a segment under it.
 */
export function ownerPathAllowed(pathname: string, messagesOn: boolean): boolean {
  const path = pathname.split("?")[0]!.replace(/\/+$/, "") || "/";
  if (path !== OWNER_BASE_PATH && !path.startsWith(`${OWNER_BASE_PATH}/`)) return false;
  const rest = path.slice(OWNER_BASE_PATH.length).replace(/^\//, "");
  const head = rest.split("/")[0] ?? "";
  if (head === "") return true;
  if (head === "messages") return messagesOn;
  return head === "properties" || head === "statements" || head === "documents" || head === "profile";
}

/** Where an owner-only account should be sent for a path it may not open. */
export function ownerRedirectFor(pathname: string, messagesOn: boolean): string | null {
  return ownerPathAllowed(pathname, messagesOn) ? null : OWNER_HOME_PATH;
}
