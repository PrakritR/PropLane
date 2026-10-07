import type { VendorReplyChoice } from "@/lib/work-order-bid-cycle";
import { VENDOR_FIND_WORK_LIST_TAB, vendorJobDetailHref, vendorWorkOrderListHref } from "@/lib/portal-detail-routes";

/**
 * The three things a vendor can do about a job they can see - on the public service page, on Find
 * work, and on their own Services (vendor-work-share-1006 addendum). Every one of them routes into
 * an EXISTING flow; nothing here is a new bid path.
 *
 *   estimate -> the existing Estimate & bid section, on "Book visit" (give_estimate / book_estimate_visit)
 *   bid      -> the same section, on "Submit bid" (submit_bid)
 *   message  -> the service's own in-app Communication thread with the manager (recordRef = the service)
 */
export type VendorJobChoiceId = "estimate" | "bid" | "message";

export const VENDOR_JOB_CHOICES: ReadonlyArray<{ id: VendorJobChoiceId; label: string; short: string }> = [
  { id: "estimate", label: "Needs an estimate visit", short: "Estimate visit" },
  { id: "bid", label: "Bid now", short: "Bid now" },
  { id: "message", label: "Message the manager", short: "Message" },
];

export const VENDOR_JOB_CHOICE_PARAM = "choice";

export function parseVendorJobChoice(raw: string | null | undefined): VendorJobChoiceId | null {
  return raw === "estimate" || raw === "bid" || raw === "message" ? raw : null;
}

/** The Estimate & bid reply a choice preselects; null for Message (it is not a reply). */
export function replyForVendorJobChoice(choice: VendorJobChoiceId): VendorReplyChoice | null {
  if (choice === "estimate") return "book_estimate_visit";
  if (choice === "bid") return "submit_bid";
  return null;
}

/** Where a choice lands on the vendor's own service page. */
export function vendorJobChoiceHref(basePath: string, workOrderId: string, choice: VendorJobChoiceId): string {
  if (choice === "message") return vendorJobDetailHref(basePath, workOrderId, "communication");
  return `${vendorJobDetailHref(basePath, workOrderId, "bid")}?${VENDOR_JOB_CHOICE_PARAM}=${choice}`;
}

/** The vendor Services tab id of the board. Kept apart from the four service stages (the one vocabulary). */
export const VENDOR_FIND_WORK_TAB = VENDOR_FIND_WORK_LIST_TAB;

export function vendorFindWorkHref(basePath: string): string {
  return vendorWorkOrderListHref(basePath, VENDOR_FIND_WORK_LIST_TAB);
}

/** The cookie that carries a texted link through sign-up / sign-in (email or Google). */
export const PENDING_SERVICE_LINK_COOKIE = "pl_svc_link";
