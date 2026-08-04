/** Client-safe types for manager Communication → SMS. */

import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";

export type ManagerSmsMessageStorageTable =
  | "manager_sms_messages"
  | "inbound_sms_log"
  | "sms_relay_messages";

export type ManagerSmsMessageRow = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  fromPhone: string | null;
  toPhone: string;
  messageSid: string | null;
  source: "work_number" | "relay" | "automated";
  createdAt: string;
  /** Which table this row lives in — set for manager-thread deletes. */
  storageTable?: ManagerSmsMessageStorageTable;
  /**
   * Carrier said this outbound message did NOT reach the handset
   * (`sms_delivery_log` status failed/undelivered, via the Twilio status
   * webhook). Absent means no adverse report — NOT proof of delivery.
   */
  deliveryFailed?: boolean;
  /** Twilio error code accompanying the failure, when the carrier sent one. */
  deliveryErrorCode?: string | null;
};

export type ManagerSmsResidentConversation = {
  residentUserId: string | null;
  residentEmail: string | null;
  name: string;
  phone: string | null;
  propertyLabel: string | null;
  /** Approved resident vs pending applicant for a house. */
  tenancyStatus?: "resident" | "applicant";
  /**
   * The counterparty's capacity in this thread. Distinguishes a leasing
   * prospect from a resident on the SAME phone/shared line.
   */
  counterpartyRole?: SmsCounterpartyRole;
  /**
   * Explicit conversation identity: `<owner>:<role>:<personRef>`. Two people on
   * one shared line always differ here, so this is the stable thread id the UI
   * should key on rather than the phone number.
   */
  conversationKey?: string;
  /**
   * EVERY stored conversation key folded into this thread. A directory
   * resident's conversation merges the keys that match them by account id or
   * phone, so this is a superset of {@link conversationKey} — and it is what a
   * delete must cover, or part of the thread survives behind an "ok".
   */
  memberKeys?: string[];
  /**
   * Work-number owner for this thread. Own account or linked owner when the
   * viewer is a co-manager with Communication (inbox) access.
   */
  ownerManagerUserId?: string | null;
  messages: ManagerSmsMessageRow[];
};

/**
 * True when a label is really just a phone number (an unknown texter whose
 * `name` fell back to the phone). Used to keep raw `+1…` strings out of the
 * Communication UI — see {@link smsConversationDisplayName}.
 */
export function isPhoneLikeLabel(value: string | null | undefined): boolean {
  const t = value?.trim();
  if (!t) return false;
  if (!/^[+()\d\s.\-]+$/.test(t)) return false;
  return t.replace(/\D/g, "").length >= 7;
}

/** What {@link smsConversationDisplayName} and its subtitle read from a row. */
export type SmsConversationLabelSource = Pick<
  ManagerSmsResidentConversation,
  "name" | "propertyLabel" | "residentEmail"
> &
  Partial<Pick<ManagerSmsResidentConversation, "phone">>;

/**
 * A stable, non-raw handle for a conversation with no name, unit or email —
 * prospect/leasing threads, which would otherwise all collapse onto one shared
 * label and be indistinguishable from each other in the list. Only the last four
 * digits appear; the full `+1…` never reaches the UI.
 */
function maskedTexterLabel(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length < 4) return null;
  return `Texter ····${digits.slice(-4)}`;
}

/**
 * A display name for an SMS conversation that never surfaces a raw phone number
 * in the UI. Until the Twilio number is production-ready the product shows the
 * resident's name (or their unit/email) instead of `+1…`. SMS threading still
 * keys on the phone/conversation key internally — this only affects the label.
 */
export function smsConversationDisplayName(resident: SmsConversationLabelSource): string {
  const name = resident.name?.trim();
  if (name && !isPhoneLikeLabel(name)) return name;
  const property = resident.propertyLabel?.trim();
  if (property) return property;
  const email = resident.residentEmail?.trim();
  if (email) return email;
  return maskedTexterLabel(resident.phone) ?? maskedTexterLabel(name) ?? "Unknown contact";
}

/**
 * The secondary line under {@link smsConversationDisplayName}. It skips whatever
 * field the display name already consumed, so a thread whose name fell back to
 * the unit (or the email) does not print the same string twice.
 */
export function smsConversationSubtitle(resident: SmsConversationLabelSource): string {
  const name = smsConversationDisplayName(resident);
  const property = resident.propertyLabel?.trim();
  if (property && property !== name) return property;
  const email = resident.residentEmail?.trim();
  if (email && email !== name) return email;
  return "";
}

/** How the Communication → SMS list is ordered (replaces Unopened/Opened/Sent folders). */
export type ManagerSmsSortId = "newest" | "oldest" | "name" | "house";

export type ManagerSmsViewFilter = "all" | "unread";

export const MANAGER_SMS_SORT_OPTIONS: { value: ManagerSmsSortId; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name A–Z" },
  { value: "house", label: "House" },
];

export type ManagerSmsConversationsPayload = {
  workNumber: string | null;
  personalPhone: string | null;
  phoneVerified: boolean;
  forwardInbound: boolean;
  smsConfigured: boolean;
  residents: ManagerSmsResidentConversation[];
};

/** @deprecated Kept for route redirects from old SMS folder URLs. */
export type ManagerSmsBucketId = "unopened" | "opened" | "schedule" | "sent" | "all";

export type RoleSmsConversationPayload = {
  messages: ManagerSmsMessageRow[];
  smsConfigured: boolean;
};

export function normalizeRoleSmsPayload(
  payload: Partial<RoleSmsConversationPayload> | null | undefined,
): RoleSmsConversationPayload {
  return {
    messages: Array.isArray(payload?.messages) ? payload.messages : [],
    smsConfigured: Boolean(payload?.smsConfigured),
  };
}

export function smsMessageBucket(
  message: ManagerSmsMessageRow,
  openedIds: ReadonlySet<string>,
): ManagerSmsBucketId {
  if (message.direction === "outbound") return "sent";
  return openedIds.has(message.id) ? "opened" : "unopened";
}

/** Legacy folder labels — SMS UI now uses All/Unread + sort instead. */
export const MANAGER_SMS_TAB_DEFS: { id: ManagerSmsBucketId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unopened", label: "Unread" },
];

export function normalizeManagerSmsConversationsPayload(
  payload: Partial<ManagerSmsConversationsPayload> | null | undefined,
): ManagerSmsConversationsPayload {
  const residents = Array.isArray(payload?.residents)
    ? payload.residents.map((resident) => ({
        residentUserId: resident?.residentUserId ?? null,
        residentEmail: resident?.residentEmail ?? null,
        name: resident?.name?.trim() || resident?.phone || resident?.residentEmail || "Resident",
        phone: resident?.phone ?? null,
        propertyLabel: resident?.propertyLabel ?? null,
        tenancyStatus: resident?.tenancyStatus === "applicant" ? ("applicant" as const) : ("resident" as const),
        counterpartyRole: resident?.counterpartyRole,
        conversationKey: resident?.conversationKey,
        memberKeys: Array.isArray(resident?.memberKeys)
          ? resident.memberKeys.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
          : undefined,
        ownerManagerUserId: resident?.ownerManagerUserId ?? null,
        messages: Array.isArray(resident?.messages) ? resident.messages : [],
      }))
    : [];
  return {
    workNumber: payload?.workNumber ?? null,
    personalPhone: payload?.personalPhone ?? null,
    phoneVerified: Boolean(payload?.phoneVerified),
    forwardInbound: payload?.forwardInbound !== false,
    smsConfigured: Boolean(payload?.smsConfigured),
    residents,
  };
}

export function smsThreadHasUnread(
  messages: ManagerSmsMessageRow[],
  openedInboundIds: ReadonlySet<string>,
): boolean {
  return messages.some((m) => m.direction === "inbound" && !openedInboundIds.has(m.id));
}

export function smsThreadBucketForLatestMessage(
  latestMessage: ManagerSmsMessageRow | null | undefined,
  openedInboundIds: ReadonlySet<string>,
): ManagerSmsBucketId | null {
  if (!latestMessage) return null;
  if (latestMessage.direction === "outbound") return "sent";
  return openedInboundIds.has(latestMessage.id) ? "opened" : "unopened";
}

export function sortSmsConversationRows<
  T extends {
    lastMessage: ManagerSmsMessageRow | null;
    resident: SmsConversationLabelSource & Pick<ManagerSmsResidentConversation, "phone">;
  },
>(rows: T[], sort: ManagerSmsSortId): T[] {
  // Order by the LABEL the row actually renders, not the raw `name` \u2014 a
  // phone-like name displays as its unit or a masked handle, so sorting on the
  // raw value makes the visible list look unsorted.
  const label = (row: T) => smsConversationDisplayName(row.resident);
  return [...rows].sort((a, b) => {
    if (sort === "name") {
      return label(a).localeCompare(label(b), undefined, { sensitivity: "base" });
    }
    if (sort === "house") {
      const byHouse = (a.resident.propertyLabel || "\uffff").localeCompare(
        b.resident.propertyLabel || "\uffff",
        undefined,
        { sensitivity: "base" },
      );
      if (byHouse !== 0) return byHouse;
      return label(a).localeCompare(label(b), undefined, { sensitivity: "base" });
    }
    const aTs = a.lastMessage?.createdAt ?? "";
    const bTs = b.lastMessage?.createdAt ?? "";
    if (!aTs && !bTs) {
      return (a.resident.phone || a.resident.name || "").localeCompare(
        b.resident.phone || b.resident.name || "",
      );
    }
    if (!aTs) return 1;
    if (!bTs) return -1;
    return sort === "oldest" ? aTs.localeCompare(bTs) : bTs.localeCompare(aTs);
  });
}

/** @deprecated Prefer {@link sortSmsConversationRows}. */
export function sortSmsRowsByLatestMessage<
  T extends { lastMessage: ManagerSmsMessageRow | null },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const aTs = a.lastMessage?.createdAt ?? "";
    const bTs = b.lastMessage?.createdAt ?? "";
    return bTs.localeCompare(aTs);
  });
}
