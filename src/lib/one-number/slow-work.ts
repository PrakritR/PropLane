/**
 * Long work: tools that dispatch a vendor, screen an applicant or move money
 * take seconds. When a confirmed write is one of them the texter gets an instant
 * acknowledgement first and the result when it lands, so the thread never sits
 * silent. Pure, so the list is reviewable and tested.
 */

export const SLOW_WORK_TOOLS: ReadonlySet<string> = new Set([
  "dispatch_vendor",
  "approve_vendor_dispatch",
  "offer_to_vendors",
  "assign_vendor",
  "schedule_vendor_visit",
  "accept_bid",
  "approve_and_pay_work_order",
  "order_background_check",
  "start_rent_payment",
]);

export const WORK_ACK_TEXT = "On it, I'll text you when it's done.";

/** Suffix of the ack's idempotency key, so it never collides with the reply's own. */
export const WORK_ACK_DEDUPE_SUFFIX = "_ack";

export function isSlowWorkTool(name: string | null | undefined): boolean {
  return SLOW_WORK_TOOLS.has(String(name ?? ""));
}
