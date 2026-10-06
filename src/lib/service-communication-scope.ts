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
  email?: string | null;
  smsNoticePhone?: string | null;
  recordRef?: unknown;
};

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
    const ref = normalizeRecordRef(thread.recordRef);
    if (!ref || ref.kind !== "service" || !ids.has(ref.id)) return false;
    return !party || !partyKnown || sameParty(thread, party);
  });
}

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
