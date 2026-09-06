import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { PRIMARY_AXIS_ADMIN_EMAIL, PRIMARY_AXIS_ADMIN_LABEL } from "@/data/inbox-scoped-directory";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import { trimmedText } from "@/lib/trimmed-text";

export type CommunicationFilterRole = "resident" | "management" | "admin" | "vendor";

export type CommunicationThreadFilters = {
  propertyIds: string[];
  roles: CommunicationFilterRole[];
  contactIds: string[];
};

export const EMPTY_COMMUNICATION_THREAD_FILTERS: CommunicationThreadFilters = {
  propertyIds: [],
  roles: [],
  contactIds: [],
};

export function communicationFiltersActive(filters: CommunicationThreadFilters): boolean {
  return filters.propertyIds.length > 0 || filters.roles.length > 0 || filters.contactIds.length > 0;
}

export function roleLabel(role: CommunicationFilterRole): string {
  if (role === "resident") return "Resident";
  if (role === "management") return "Manager";
  if (role === "vendor") return "Vendor";
  return "PropLane admin";
}

/** Admin synthetic contact for person picker. */
export function axisAdminFilterContact(): InboxScopedContact {
  return {
    id: "axis-admin",
    name: PRIMARY_AXIS_ADMIN_LABEL,
    email: PRIMARY_AXIS_ADMIN_EMAIL,
    role: "manager",
  };
}

export function contactMatchesFilterRole(contact: InboxScopedContact, role: CommunicationFilterRole): boolean {
  if (role === "admin") return contact.id === "axis-admin" || trimmedText(contact.email).toLowerCase() === PRIMARY_AXIS_ADMIN_EMAIL.toLowerCase();
  if (role === "vendor") return contact.role === "vendor";
  if (role === "resident") return contact.role === "resident";
  return contact.role === "manager" && contact.id !== "axis-admin";
}

export function contactsForSelectedRoles(
  contacts: InboxScopedContact[],
  roles: CommunicationFilterRole[],
): InboxScopedContact[] {
  if (roles.length === 0) return contacts;
  return contacts.filter((c) => roles.some((role) => contactMatchesFilterRole(c, role)));
}

export function propertyOptionsFromFilterContacts(
  contacts: InboxScopedContact[],
): { value: string; label: string }[] {
  const byId = new Map<string, string>();
  for (const contact of contacts) {
    if (contact.role !== "resident") continue;
    const id = trimmedText(contact.propertyId) || trimmedText(contact.propertyLabel);
    if (!id) continue;
    const label = trimmedText(contact.propertyLabel) || id;
    if (!byId.has(id)) byId.set(id, label);
  }
  return [...byId.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

function emailMatchesContact(email: string | null | undefined, contact: InboxScopedContact): boolean {
  const a = trimmedText(email).toLowerCase();
  const b = trimmedText(contact.email).toLowerCase();
  return Boolean(a && b && a === b);
}

/** Email/SMS thread passes property + role + person filters (empty = no restriction). */
export function threadPassesCommunicationFilters(args: {
  filters: CommunicationThreadFilters;
  contacts: InboxScopedContact[];
  /** Recipient / counterparty email on the thread. */
  counterpartyEmail?: string | null;
  propertyId?: string | null;
  propertyLabel?: string | null;
  /** SMS resident-only threads. */
  isResidentThread?: boolean;
  /** Authoritative SMS thread role, when filtering an SMS conversation. */
  counterpartyRole?: SmsCounterpartyRole;
}): boolean {
  const { filters } = args;
  if (!communicationFiltersActive(filters)) return true;

  const adminEmail = PRIMARY_AXIS_ADMIN_EMAIL.toLowerCase();
  const counterparty = trimmedText(args.counterpartyEmail).toLowerCase();

  const matchedContacts = args.contacts.filter((c) => emailMatchesContact(counterparty, c));
  const isAdminThread = counterparty === adminEmail;

  if (filters.propertyIds.length > 0) {
    const propertyOk =
      (args.propertyId && filters.propertyIds.includes(args.propertyId)) ||
      (args.propertyLabel && filters.propertyIds.includes(args.propertyLabel)) ||
      matchedContacts.some((c) => {
        const pid = trimmedText(c.propertyId) || trimmedText(c.propertyLabel);
        return pid ? filters.propertyIds.includes(pid) : false;
      });
    if (!propertyOk) return false;
  }

  if (filters.roles.length > 0) {
    const roleOk = filters.roles.some((role) => {
      if (role === "admin") return isAdminThread;
      if (role === "resident") {
        if (args.counterpartyRole) {
          return args.counterpartyRole === "resident" || args.counterpartyRole === "applicant";
        }
        if (args.isResidentThread) return true;
        return matchedContacts.some((c) => c.role === "resident");
      }
      if (role === "vendor") {
        if (args.counterpartyRole) return args.counterpartyRole === "vendor";
        return matchedContacts.some((c) => c.role === "vendor");
      }
      if (args.counterpartyRole) return args.counterpartyRole === "manager";
      return matchedContacts.some((c) => c.role === "manager" && c.id !== "axis-admin");
    });
    if (!roleOk) return false;
  }

  if (filters.contactIds.length > 0) {
    const personOk =
      (isAdminThread && filters.contactIds.includes("axis-admin")) ||
      matchedContacts.some((c) => filters.contactIds.includes(c.id));
    if (!personOk) return false;
  }

  return true;
}
