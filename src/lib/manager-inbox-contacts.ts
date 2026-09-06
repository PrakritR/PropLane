import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { PRIMARY_AXIS_ADMIN_EMAIL, PRIMARY_AXIS_ADMIN_LABEL } from "@/data/inbox-scoped-directory";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { readOwnActiveManagerVendorRows, isVendorCategorySettingsRow } from "@/lib/manager-vendors-storage";
import { readProRelationships } from "@/lib/pro-relationships";
import { trimmedText } from "@/lib/trimmed-text";

/** Merge contact lists by email — first occurrence wins. */
export function mergeInboxScopedContacts(...lists: InboxScopedContact[][]): InboxScopedContact[] {
  const out: InboxScopedContact[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const contact of list) {
      const key = trimmedText(contact?.email).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...contact,
        name: trimmedText(contact.name) || key,
        email: key,
      });
    }
  }
  return out;
}

/** Local calendar date as YYYY-MM-DD, to compare against a stored move-out date. */
function todayIsoDate(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

/** Approved residents + pending applicants + linked co-managers + vendors for Communication. */
export function buildManagerInboxLiveContacts(userId: string | null | undefined): InboxScopedContact[] {
  const out: InboxScopedContact[] = [];
  const seen = new Set<string>();

  for (const row of readManagerApplicationRows()) {
    const bucket = String(row.bucket ?? "").trim();
    const email = trimmedText(row.email).toLowerCase();
    if ((bucket !== "approved" && bucket !== "pending") || !email) continue;
    // Skip in-progress drafts that are not real applications yet.
    if (bucket === "pending" && String(row.stage ?? "").trim().toLowerCase() === "in progress") continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const propertyLabel = trimmedText(row.property) || undefined;
    const propertyId = trimmedText(row.assignedPropertyId) || trimmedText(row.propertyId) || undefined;
    // A resident whose move-out date has passed is PAST, not current (PRP-150).
    // Read from the manual detail first and the application second, the same
    // order `resolveLeaseDatesForBilling` uses, so the picker and the ledger
    // agree about when a tenancy ended.
    const moveOut =
      trimmedText(row.manualResidentDetails?.moveOutDate) ||
      trimmedText(row.application?.leaseEnd);
    const movedOut = Boolean(moveOut) && moveOut < todayIsoDate();
    const tenancyStatus =
      bucket === "approved" ? (movedOut ? "past" : "resident") : "applicant";
    out.push({
      id: `res-${trimmedText(row.id)}`,
      name: trimmedText(row.name) || email,
      email,
      role: "resident",
      propertyLabel,
      propertyId,
      tenancyStatus,
    });
  }

  if (userId) {
    for (const rel of readProRelationships(userId)) {
      const email = trimmedText(rel.linkedAxisId);
      if (!email || seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      out.push({
        id: `rel-${rel.id}`,
        name: trimmedText(rel.linkedDisplayName) || email,
        email,
        role: "manager",
      });
    }

    for (const vendor of readOwnActiveManagerVendorRows(userId)) {
      if (isVendorCategorySettingsRow(vendor)) continue;
      const email = trimmedText(vendor.email);
      if (!email || seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      out.push({
        id: `ven-${vendor.id}`,
        name: trimmedText(vendor.name) || email,
        email,
        role: "vendor",
      });
    }
  }

  return out;
}

export function axisAdminScheduleContact(): InboxScopedContact {
  return {
    id: "axis-admin",
    name: PRIMARY_AXIS_ADMIN_LABEL,
    email: PRIMARY_AXIS_ADMIN_EMAIL,
    role: "manager",
  };
}

export function propertyOptionsFromContacts(contacts: InboxScopedContact[]): { id: string; label: string }[] {
  const byId = new Map<string, string>();
  for (const contact of contacts) {
    if (contact.role !== "resident") continue;
    const id = trimmedText(contact.propertyId);
    if (!id) continue;
    const label = trimmedText(contact.propertyLabel) || id;
    if (!byId.has(id)) byId.set(id, label);
  }
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export function residentsForProperty(contacts: InboxScopedContact[], propertyId: string | null): InboxScopedContact[] {
  const residents = contacts.filter((c) => c.role === "resident");
  if (!propertyId) return residents;
  return residents.filter((c) => c.propertyId === propertyId);
}
