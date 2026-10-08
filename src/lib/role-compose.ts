/**
 * New message is one composer for every role (`ManagerCommunicationComposeModal`).
 * This module is the per-role seam: what each role's composer may offer, the
 * people it may pick, and the payload a vendor or resident panel's own send
 * function receives. The server re-authorizes every recipient regardless.
 */
import {
  categoryForContactRole,
  PRIMARY_AXIS_ADMIN_LABEL,
  type InboxRecipientCategory,
  type InboxScopedContact,
} from "@/data/inbox-scoped-directory";
import {
  composeDirectoryCategories,
  type InboxComposeDirectoryCategory,
} from "@/lib/inbox-compose-recipients";

export type ComposePortal = "manager" | "vendor" | "resident";

export type RoleComposeChannel = "proplane" | "email" | "sms";

export type RoleComposeCapabilities = {
  /** Channel toggles shown in the tools row (empty: one fixed delivery, no toggle). */
  channels: RoleComposeChannel[];
  /** Channel selection a fresh composer opens with (non-manager roles). */
  defaultChannels: RoleComposeChannel[];
  /** Schedule for later. Residents schedule from the thread composer only. */
  schedule: boolean;
  /** Paperclip: the role's send route accepts `attachmentUrls`. */
  attach: boolean;
  /** Sparkles "Draft with PropLane": only the manager draft endpoint exists. */
  draft: boolean;
  /** Typed email/phone recipients who are not on the list. */
  otherRecipients: boolean;
};

export function roleComposeCapabilities(
  portal: ComposePortal,
  smsUiEnabled = false,
): RoleComposeCapabilities {
  if (portal === "vendor") {
    // The vendor send route is one sponsored delivery (email plus the
    // recipient's inbox copy); it has no in-app-only mode, no scheduled-send
    // route, and there is no vendor draft endpoint.
    return {
      channels: [],
      defaultChannels: ["email"],
      schedule: false,
      attach: true,
      draft: false,
      otherRecipients: false,
    };
  }
  if (portal === "resident") {
    return {
      channels: ["proplane", "email"],
      defaultChannels: ["proplane", "email"],
      schedule: false,
      attach: true,
      draft: false,
      otherRecipients: false,
    };
  }
  return {
    channels: smsUiEnabled ? ["proplane", "email", "sms"] : ["proplane", "email"],
    defaultChannels: ["email"],
    schedule: true,
    attach: true,
    draft: true,
    otherRecipients: true,
  };
}

/** What a vendor or resident panel's send function receives from the composer. */
export type ScopedInboxSendPayload = {
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  toLabel: string;
  toEmailLine: string;
  /** Same as toEmailLine but with "All management"/"All residents" placeholder addresses stripped. */
  directRecipientEmailLine: string;
  /** Server-revalidated account ids for role-scoped senders. */
  directRecipientUserIds: string[];
  includesAxisAdmin: boolean;
  includesDirectoryRecipients: boolean;
  /** Broadcast categories selected, resolved to real recipients server-side. */
  broadcastCategories: ("management" | "resident")[];
  scheduleLater?: boolean;
  sendAt?: string;
  deliverViaEmail?: boolean;
  deliverViaSms?: boolean;
  /** In-app (PropLane inbox) delivery. */
  deliverViaInbox?: boolean;
  /** Uploaded attachment URLs (`/api/portal/inbox-attachments/...`). */
  attachmentUrls?: string[];
  /** Property-scoped resident -> manager thread (tour, listing, charge). */
  propertyId?: string;
  propertyTitle?: string;
  managerUserId?: string;
  /** Stable id for retrying one unchanged compose operation. */
  sendId?: string;
};

export type ScopedPersonKey = "admin" | `id:${string}`;

/** A vendor or resident sees a name, what they are to them, and the house. */
export function scopedContactOptionLabel(contact: InboxScopedContact): string {
  const property = contact.propertyLabel?.trim();
  const status =
    contact.role === "resident"
      ? contact.tenancyStatus === "applicant"
        ? "Applicant"
        : "Resident"
      : null;
  const bits = [contact.name, status, property || contact.email].filter(Boolean);
  return bits.join(" · ");
}

/** The people a vendor or resident can pick under one section (their current scoped list). */
export function scopedPeopleForCategory(
  category: InboxComposeDirectoryCategory,
  portal: ComposePortal,
  contacts: InboxScopedContact[],
): { key: ScopedPersonKey; label: string }[] {
  if (category === "admin") return [{ key: "admin", label: PRIMARY_AXIS_ADMIN_LABEL }];
  const sort = (a: InboxScopedContact, b: InboxScopedContact) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (category === "vendor") {
    return contacts
      .filter((c) => c.role === "vendor")
      .sort(sort)
      .map((c) => ({ key: `id:${c.id}` as const, label: scopedContactOptionLabel(c) }));
  }
  const roleCategory: InboxRecipientCategory = category === "resident" ? "resident" : "management";
  return contacts
    .filter((c) => categoryForContactRole(portal, c.role) === roleCategory)
    .sort(sort)
    .map((c) => ({ key: `id:${c.id}` as const, label: scopedContactOptionLabel(c) }));
}

/** The To sections a role's composer lists (vendor: Manager + admin; resident: household, Manager, admin). */
export function scopedComposeCategories(
  portal: Exclude<ComposePortal, "manager">,
  contacts: InboxScopedContact[],
): InboxComposeDirectoryCategory[] {
  return composeDirectoryCategories(portal, contacts);
}

/** The section a contact is listed under in the role's To picker. */
export function composeCategoryForContact(
  portal: ComposePortal,
  contact: InboxScopedContact,
): InboxComposeDirectoryCategory {
  if (contact.role === "vendor") return "vendor";
  if (contact.role === "resident") {
    if (portal === "manager") {
      return contact.propertyId?.trim() && contact.propertyLabel?.trim()
        ? (`house:${contact.propertyId.trim()}` as const)
        : "unassigned_residents";
    }
    return "resident";
  }
  return "management";
}
