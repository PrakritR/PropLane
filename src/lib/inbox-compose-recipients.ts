import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

/** To-section buckets in the scoped compose modal (excludes manager-only "other"). */
export type InboxComposeDirectoryCategory =
  | "applicant"
  | "resident"
  | "past_resident"
  | "management"
  | "admin"
  | "vendor"
  /** Residents with no property attached — rare, but must not vanish from the picker. */
  | "unassigned_residents"
  /** Manager portal: one section per house that has at least one resident contact. */
  | `house:${string}`;

export function isHouseComposeCategory(
  category: string,
): category is `house:${string}` {
  return category.startsWith("house:");
}

export function houseIdFromComposeCategory(category: `house:${string}`): string {
  return category.slice("house:".length);
}

/** Stable house list for the manager To picker — sorted by property label. */
export function residentHousesFromContacts(
  contacts: InboxScopedContact[],
): { id: string; label: string }[] {
  const map = new Map<string, string>();
  for (const contact of contacts) {
    if (contact.role !== "resident") continue;
    const id = contact.propertyId?.trim();
    const label = contact.propertyLabel?.trim();
    if (!id || !label) continue;
    map.set(id, label);
  }
  return [...map.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export function houseComposeCategoryLabel(
  category: `house:${string}`,
  contacts: InboxScopedContact[],
): string {
  const propertyId = houseIdFromComposeCategory(category);
  const label = contacts.find((c) => c.propertyId?.trim() === propertyId)?.propertyLabel?.trim();
  return label ?? "House";
}

/**
 * Manager portal: houses first, then Manager / Vendor / PropLane admin.
 *
 * Resident tenancy buckets (potential / current / past) stay available on
 * resident and vendor portals. Managers pick people by house so "everyone at
 * Brooklyn" is one tap at portfolio scale, with role groups beside the houses.
 */
export function composeDirectoryCategories(
  portal: "resident" | "manager" | "vendor",
  contacts: InboxScopedContact[],
): InboxComposeDirectoryCategory[] {
  if (portal === "manager") {
    const cats: InboxComposeDirectoryCategory[] = [];
    for (const house of residentHousesFromContacts(contacts)) {
      cats.push(`house:${house.id}`);
    }
    if (
      contacts.some(
        (c) => c.role === "resident" && !(c.propertyId?.trim() && c.propertyLabel?.trim()),
      )
    ) {
      cats.push("unassigned_residents");
    }
    cats.push("management", "vendor", "admin");
    return cats;
  }
  if (portal === "vendor") return ["management", "admin"];
  return ["resident", "management", "admin"];
}

/** PropLane admin is a single fixed recipient — no second picker step. */
export function isAdminOnlyDirectorySelection(categories: InboxComposeDirectoryCategory[]): boolean {
  return categories.length === 1 && categories[0] === "admin";
}

/** Allowed Which-people keys for the current To sections (includes synthetic admin). */
export function composeValidPersonKeys(
  flatOptionValues: string[],
  categories: InboxComposeDirectoryCategory[],
): Set<string> {
  const keys = new Set(flatOptionValues);
  if (categories.includes("admin")) keys.add("admin");
  return keys;
}

export function mergeAdminComposePersonKey<T extends string>(
  categories: InboxComposeDirectoryCategory[],
  keys: T[],
): T[] {
  if (!categories.includes("admin")) {
    return keys.filter((k) => k !== "admin");
  }
  if (keys.includes("admin" as T)) return keys;
  return [...keys, "admin" as T];
}
