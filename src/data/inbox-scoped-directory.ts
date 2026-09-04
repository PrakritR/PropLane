/**
 * Portal compose address books. Expand when messaging is backed by real relationships.
 */

export type InboxContactRole = "manager" | "resident" | "vendor";

export type InboxScopedContact = {
  id: string;
  name: string;
  email: string;
  role: InboxContactRole;
  /** Resident listing label for grouped compose / schedule pickers. */
  propertyLabel?: string;
  propertyId?: string;
  /** Approved tenant vs pending applicant on a house (resident role only). */
  /**
   * Where this person is in their tenancy.
   *
   * `past` is a resident whose move-out date has gone by. It exists so the To
   * picker can separate potential, current and past residents (PRP-150) —
   * writing to "residents" should not silently include people who moved out.
   */
  tenancyStatus?: "resident" | "applicant" | "past";
};

import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

/** Axis partner inbox (admin). */
export const PRIMARY_AXIS_ADMIN_EMAIL = PRIMARY_ADMIN_EMAIL;

export const PRIMARY_AXIS_ADMIN_LABEL = "PropLane admin";

/** UI buckets — how the compose modal groups recipients. */
export type InboxRecipientCategory = "admin" | "management" | "resident" | "vendor";

/** Which address-book roles appear under Management / Resident / Vendor for each portal. */
export function rolesForRecipientCategory(
  portal: "resident" | "manager" | "vendor",
  category: InboxRecipientCategory,
): InboxContactRole[] {
  if (category === "admin") return [];
  if (category === "vendor") return portal === "manager" ? ["vendor"] : [];
  if (portal === "vendor") {
    if (category === "management") return ["manager"];
    return [];
  }
  if (portal === "manager") {
    if (category === "management") return ["manager"];
    if (category === "resident") return ["resident"];
    return [];
  }
  if (portal === "resident") {
    if (category === "management") return ["manager"];
    if (category === "resident") return ["resident"];
    return [];
  }
  if (category === "management") return ["manager"];
  return ["resident"];
}

export function categoryForContactRole(
  portal: "resident" | "manager" | "vendor",
  role: InboxContactRole,
): InboxRecipientCategory {
  if (role === "vendor") return "vendor";
  if (role === "resident") return "resident";
  return "management";
}

function contactsVisibleInPortal(portal: "resident" | "manager" | "vendor", list: InboxScopedContact[]) {
  const roles = new Set<InboxContactRole>([
    ...rolesForRecipientCategory(portal, "management"),
    ...rolesForRecipientCategory(portal, "resident"),
    ...rolesForRecipientCategory(portal, "vendor"),
  ]);
  return list.filter((c) => roles.has(c.role));
}

export function contactsForPortal(
  portal: "resident" | "manager" | "vendor",
  liveContacts: InboxScopedContact[] = [],
): InboxScopedContact[] {
  return contactsVisibleInPortal(portal, liveContacts);
}

export function broadcastStubForCategory(
  category: Exclude<InboxRecipientCategory, "vendor">,
): { label: string; email: string } {
  if (category === "admin") {
    return { label: `All admins (${PRIMARY_AXIS_ADMIN_LABEL})`, email: PRIMARY_AXIS_ADMIN_EMAIL };
  }
  if (category === "management") {
    return { label: "All management", email: "broadcast-management@axis.local" };
  }
  return { label: "All residents", email: "broadcast-residents@axis.local" };
}
