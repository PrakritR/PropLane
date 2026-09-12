import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { PRIMARY_AXIS_ADMIN_EMAIL, PRIMARY_AXIS_ADMIN_LABEL } from "@/data/inbox-scoped-directory";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { readOwnActiveManagerVendorRows, isVendorCategorySettingsRow } from "@/lib/manager-vendors-storage";
import { readProRelationships } from "@/lib/pro-relationships";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
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
    // Same derivation the Residents directory uses for its room column.
    const roomLabel =
      trimmedText(row.manualResidentDetails?.roomNumber) ||
      getRoomChoiceLabel(trimmedText(row.assignedRoomChoice) || trimmedText(row.application?.roomChoice1))
        .split(" · ")[0]
        ?.trim() ||
      undefined;
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
      roomLabel,
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

/**
 * Per-property audience for New message (PRP-315).
 *
 * "Water is off tomorrow" goes to the residents of ONE house, not to every
 * resident the manager has. The compose picker offers one option per property
 * under Residents & applicants; sending expands it to that property's CURRENT
 * residents — an applicant has not moved in and someone with a past move-out
 * date has left, so neither is a resident of the house today.
 */
const PROPERTY_AUDIENCE_PREFIX = "broadcast:property:";

export function propertyAudienceKey(propertyId: string): string {
  return `${PROPERTY_AUDIENCE_PREFIX}${trimmedText(propertyId)}`;
}

/** The property id inside a per-property audience key, or null for any other key. */
export function parsePropertyAudienceKey(key: string): string | null {
  if (!key.startsWith(PROPERTY_AUDIENCE_PREFIX)) return null;
  const id = trimmedText(key.slice(PROPERTY_AUDIENCE_PREFIX.length));
  return id || null;
}

export function propertyAudienceLabel(propertyLabel: string): string {
  return `All residents · ${propertyLabel}`;
}

/** Current residents of one property — the people "All residents · <house>" actually reaches. */
export function residentsForPropertyAudience(
  contacts: InboxScopedContact[],
  propertyId: string,
): InboxScopedContact[] {
  const id = trimmedText(propertyId);
  if (!id) return [];
  return contacts.filter(
    (c) =>
      c.role === "resident" &&
      trimmedText(c.propertyId) === id &&
      c.tenancyStatus !== "applicant" &&
      c.tenancyStatus !== "past",
  );
}

/** One picker option per property that has at least one current resident. */
export function propertyAudienceOptions(
  contacts: InboxScopedContact[],
): { key: string; label: string; propertyId: string; propertyLabel: string }[] {
  return propertyOptionsFromContacts(contacts)
    .filter((property) => residentsForPropertyAudience(contacts, property.id).length > 0)
    .map((property) => ({
      key: propertyAudienceKey(property.id),
      label: propertyAudienceLabel(property.label),
      propertyId: property.id,
      propertyLabel: property.label,
    }));
}

/**
 * Who a conversation is with, by NAME (PRP-315). A thread row used to be
 * titled by the other side's email (or phone), so a landlord decoded addresses
 * to find the person they meant. When the counterparty is someone in the
 * manager's directory, use that person's name; the sender-supplied `from` is
 * next; the address is the last resort.
 */
export function inboxCounterpartyName(
  counterpartyEmail: string | null | undefined,
  from: string | null | undefined,
  contacts: readonly InboxScopedContact[] | null | undefined,
): string {
  const email = trimmedText(counterpartyEmail).toLowerCase();
  if (email && contacts) {
    const match = contacts.find((c) => trimmedText(c.email).toLowerCase() === email);
    const name = trimmedText(match?.name);
    if (name && name.toLowerCase() !== email) return name;
  }
  const fromName = trimmedText(from);
  if (fromName) return fromName;
  return trimmedText(counterpartyEmail);
}
