/**
 * The `recordRef` a service notification is stamped with, so the service record's own Communication section
 * (`service-communication-scope.ts`) finds the conversation: an offer, a bid, a visit time, a "done" - every
 * work-order and add-on action event - is about ONE service. Pure and server-safe.
 *
 * The thread keeps the FIRST ref it is stamped with (`deliverPortalInboxMessage` never overwrites one), so a
 * party's single conversation is attributed to whichever service spoke to them first.
 */
import { normalizeRecordRef, type RecordRef } from "@/lib/portals/record-kinds";

const SERVICE_EVENT_DOMAINS = new Set(["work_order", "service_request"]);

/** The service ref for an action event, or undefined for any other domain (or a missing entity). */
export function serviceRecordRefForEvent(domain: string | null | undefined, entityId: string | null | undefined, title?: unknown): RecordRef | undefined {
  if (!domain || !SERVICE_EVENT_DOMAINS.has(domain)) return undefined;
  const id = (entityId ?? "").trim();
  // A vendor invoice decision rides a synthetic `invoice:` id; it is not a service record.
  if (!id || id.startsWith("invoice:")) return undefined;
  const label = typeof title === "string" && title.trim() ? title.trim() : "Service";
  return normalizeRecordRef({ kind: "service", id, label }) ?? undefined;
}
