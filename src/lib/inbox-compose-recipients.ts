import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

/** To-section buckets in the scoped compose modal (excludes manager-only "other"). */
export type InboxComposeDirectoryCategory =
  | "applicant"
  | "resident"
  | "past_resident"
  | "management"
  | "admin"
  | "vendor";

/**
 * Manager portal: management = co-managers; vendor only when the directory has
 * vendors.
 *
 * "PropLane admin" is deliberately NOT offered to a manager (PRP-150). A manager
 * writing to us is a support request, not portal correspondence, and having it
 * sit in the same picker as their own residents and co-managers made the list
 * read as though PropLane were one of their contacts. Residents and vendors keep
 * it — for them it is the only way to reach anyone outside their own manager.
 */
export function composeDirectoryCategories(
  portal: "resident" | "manager" | "vendor",
  contacts: InboxScopedContact[],
): InboxComposeDirectoryCategory[] {
  if (portal === "manager") {
    // Three resident buckets, not one (PRP-150): writing to "residents" should
    // not silently include an applicant who has not moved in or someone who
    // moved out. Each only appears when it has someone in it.
    const cats: InboxComposeDirectoryCategory[] = [];
    const residentsWith = (status: InboxScopedContact["tenancyStatus"]) =>
      contacts.some((c) => c.role === "resident" && (c.tenancyStatus ?? "resident") === status);
    if (residentsWith("applicant")) cats.push("applicant");
    // Always offered: a manager with no residents yet still needs the section to
    // exist, and it is the one every other bucket is defined against.
    cats.push("resident");
    if (residentsWith("past")) cats.push("past_resident");
    if (contacts.some((c) => c.role === "manager")) cats.push("management");
    if (contacts.some((c) => c.role === "vendor")) cats.push("vendor");
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
