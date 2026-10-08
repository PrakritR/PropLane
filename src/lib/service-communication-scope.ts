/**
 * A service's Communication section is about THIS service (studio plan mobile-step-tabs-1004, Part 3, D9):
 * one tab per party - the resident first, then every vendor the job went to - and each tab shows only the
 * threads stamped with this service's `recordRef`. The person-wide history (rent notices, other houses) is
 * the main Communication page; the section ends with a link to it.
 *
 * An add-on's vendor conversations ride its linked vendor job, so the add-on's scope is two record ids:
 * its own and the job's (`add-on-vendor-job.ts`). Pure, over the threads already in the inbox cache.
 */
import { normalizeRecordRef } from "@/lib/portals/record-kinds";
import { inboxThreadMessages, parseInboxStampMs, type InboxThreadMessage, type PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { smsNoticePhone } from "@/lib/sms-inbox-identity";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";

export type ServiceCommunicationPartyTab = {
  /** `resident`, or `vendor:<directory id>`. */
  id: string;
  kind: "resident" | "vendor";
  name: string;
  email?: string;
  phone?: string;
};

type ThreadLike = {
  id?: string;
  email?: string | null;
  smsNoticePhone?: string | null;
  recordRef?: unknown;
  /** The work order a dispatch-agent thread was opened for (`vendorAgentThreadServiceStamp`). */
  workOrderId?: string | null;
  /** Each turn may carry the record it was composed about (`InboxThreadMessage.recordRef`). */
  messages?: readonly { recordRef?: unknown }[] | null;
};

/** The id of a `service` recordRef, or null for any other kind or a malformed value. */
function serviceRefId(value: unknown): string | null {
  const ref = normalizeRecordRef(value);
  return ref && ref.kind === "service" ? ref.id : null;
}

/**
 * Is the THREAD itself about one of these services? Any one sign is enough: its `recordRef` (the first record
 * composed from), or the work order a dispatch-agent session opened it for (`workOrderId`, also spelled in its
 * id `vendor_agent_<work order>_<vendor>`).
 */
function threadLevelAboutService(thread: ThreadLike, ids: ReadonlySet<string>): boolean {
  const ref = serviceRefId(thread.recordRef);
  if (ref && ids.has(ref)) return true;
  const workOrderId = thread.workOrderId?.trim();
  if (workOrderId && ids.has(workOrderId)) return true;
  const threadId = thread.id ?? "";
  if (threadId.startsWith("vendor_agent_")) {
    for (const id of ids) if (threadId.startsWith(`vendor_agent_${id}_`)) return true;
  }
  return false;
}

/**
 * Is the thread about one of these services? A thread keeps the recordRef of whoever first composed from a
 * record, so a LATER job with the same vendor (or resident) reuses the thread under its first job's ref; that
 * later job is found through its own turns, each stamped with the record it was composed from.
 */
export function threadAboutService(thread: ThreadLike, ids: ReadonlySet<string>): boolean {
  if (threadLevelAboutService(thread, ids)) return true;
  return (thread.messages ?? []).some((message) => {
    const id = serviceRefId(message?.recordRef);
    return Boolean(id && ids.has(id));
  });
}

/**
 * Does one turn belong to these services? A stamped turn answers for itself; an unstamped turn (the root, or
 * anything written before turns were stamped) belongs to whatever the thread is about.
 */
export function messageAboutService(thread: ThreadLike, message: { recordRef?: unknown }, ids: ReadonlySet<string>): boolean {
  const own = normalizeRecordRef(message.recordRef);
  if (own) return own.kind === "service" && ids.has(own.id);
  return threadLevelAboutService(thread, ids);
}

/** Every record id whose threads belong to this service: the service itself, plus the linked vendor job. */
export function serviceRecordIds(serviceId: string, linkedWorkOrderId?: string | null): string[] {
  return [...new Set([serviceId, linkedWorkOrderId ?? ""].map((id) => id.trim()).filter(Boolean))];
}

function sameParty(thread: ThreadLike, party: Pick<ServiceCommunicationPartyTab, "email" | "phone">): boolean {
  const partyEmail = party.email?.trim().toLowerCase() ?? "";
  const threadEmail = (thread.email ?? "").trim().toLowerCase();
  if (partyEmail && threadEmail && partyEmail === threadEmail) return true;
  const partyPhone = party.phone?.trim() ? smsNoticePhone(party.phone) : "";
  if (partyPhone && thread.smsNoticePhone && smsNoticePhone(thread.smsNoticePhone) === partyPhone) return true;
  return false;
}

/**
 * The threads one party's tab shows: stamped with this service (or its linked job) AND with that party.
 * No counterparty-only matching: a thread that merely shares the contact's email is not about this
 * service, however recent it is. A party with no way to tell them apart (no email, no phone) sees every
 * thread stamped to the service, so a tab is never blank for want of an address.
 */
export function serviceThreadsForParty<T extends ThreadLike>(
  threads: readonly T[],
  scope: { recordIds: readonly string[]; party?: Pick<ServiceCommunicationPartyTab, "email" | "phone"> | null },
): T[] {
  const ids = new Set(scope.recordIds.map((id) => id.trim()).filter(Boolean));
  const party = scope.party ?? null;
  const partyKnown = Boolean(party?.email?.trim() || party?.phone?.trim());
  return threads.filter((thread) => {
    if (!threadAboutService(thread, ids)) return false;
    return !party || !partyKnown || sameParty(thread, party);
  });
}

/**
 * The "Everyone" view's threads: the union of every party's threads about this service, in the order the inbox
 * lists them, each thread once. With no party on the list, every thread about the service.
 */
export function serviceThreadsForEveryone<T extends ThreadLike>(
  threads: readonly T[],
  scope: { recordIds: readonly string[]; parties: readonly Pick<ServiceCommunicationPartyTab, "email" | "phone">[] },
): T[] {
  const keep = new Set<T>();
  const lists = scope.parties.length === 0 ? [null] : scope.parties;
  for (const party of lists) {
    for (const thread of serviceThreadsForParty(threads, { recordIds: scope.recordIds, party })) keep.add(thread);
  }
  return threads.filter((thread) => keep.has(thread));
}

/** Which party a thread is with: the first tab whose address or number the thread carries, else none. */
export function serviceThreadParty<T extends ThreadLike>(
  thread: T,
  parties: readonly ServiceCommunicationPartyTab[],
): ServiceCommunicationPartyTab | null {
  return parties.find((party) => Boolean(party.email?.trim() || party.phone?.trim()) && sameParty(thread, party)) ?? null;
}

export type ServiceTimelineEntry = {
  thread: PersistedInboxThread;
  message: InboxThreadMessage;
  /** The turn's position in its own thread (the root is 0): the direction rules read it. */
  index: number;
  party: ServiceCommunicationPartyTab | null;
  sortMs: number;
};

/**
 * Every turn about this service from every party's thread, oldest first. Only the turns that belong to the
 * service are kept (`messageAboutService`), so a vendor's thread that also carries an earlier job's turns shows
 * just this job's here.
 */
export function serviceTimeline(
  threads: readonly PersistedInboxThread[],
  scope: { recordIds: readonly string[]; parties: readonly ServiceCommunicationPartyTab[] },
): ServiceTimelineEntry[] {
  const ids = new Set(scope.recordIds.map((id) => id.trim()).filter(Boolean));
  return serviceThreadsForEveryone(threads, scope)
    .flatMap((thread) => {
      const party = serviceThreadParty(thread, scope.parties);
      return inboxThreadMessages(thread)
        .map((message, index) => ({ thread, message, index, party, sortMs: parseInboxStampMs(message.at) ?? 0 }))
        .filter((entry) => messageAboutService(thread, entry.message, ids));
    })
    .sort((a, b) => a.sortMs - b.sortMs);
}

/** The party a reply goes to: the tab with this id, else the first (the resident). */
export function serviceReplyParty(parties: readonly ServiceCommunicationPartyTab[], toId: string): ServiceCommunicationPartyTab | null {
  return parties.find((party) => party.id === toId) ?? parties[0] ?? null;
}

/** The word after a party's name in a multi-party timeline. */
export const SERVICE_PARTY_LABEL: Record<ServiceCommunicationPartyTab["kind"], string> = { resident: "Resident", vendor: "Vendor" };

/**
 * The tabs of the section: the resident, then one per vendor with an offer or a bid on the job (a
 * withdrawn or declined offer still counts - they were asked, so the conversation is real).
 */
export function serviceCommunicationParties(input: {
  resident: { name: string; email?: string; phone?: string } | null;
  offers: readonly Pick<WorkOrderVendorOffer, "vendorDirectoryId" | "vendorName" | "vendorEmail">[];
  bids?: readonly Pick<WorkOrderBid, "vendorDirectoryId" | "vendorName" | "vendorEmail" | "vendorUserId">[];
  /** The manager's vendor roster, for a vendor's phone when only the directory id is known. */
  roster?: readonly { id: string; name?: string | null; email?: string | null; phone?: string | null }[];
}): ServiceCommunicationPartyTab[] {
  const tabs: ServiceCommunicationPartyTab[] = [];
  if (input.resident) {
    tabs.push({ id: "resident", kind: "resident", name: input.resident.name, email: input.resident.email, phone: input.resident.phone });
  }
  const seen = new Set<string>();
  const add = (directoryId: string | null | undefined, userId: string | null | undefined, name?: string, email?: string) => {
    const key = directoryId?.trim() || userId?.trim() || "";
    if (!key || seen.has(key)) return;
    seen.add(key);
    const record = input.roster?.find((vendor) => vendor.id === directoryId);
    tabs.push({
      id: `vendor:${key}`,
      kind: "vendor",
      name: name?.trim() || record?.name?.trim() || "Vendor",
      email: email?.trim() || record?.email?.trim() || undefined,
      phone: record?.phone?.trim() || undefined,
    });
  };
  for (const offer of input.offers) add(offer.vendorDirectoryId, null, offer.vendorName, offer.vendorEmail);
  for (const bid of input.bids ?? []) add(bid.vendorDirectoryId, bid.vendorUserId, bid.vendorName, bid.vendorEmail);
  return tabs;
}
