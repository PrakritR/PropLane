/**
 * An add-on service on a vendor: the LINKED vendor job (studio plan mobile-step-tabs-1004, Part 3, D7).
 *
 * Add-ons (storage, parking) live in `portal_service_request_records` and have no bidding tables. The
 * vendor workflow - offers, bids, approve, schedule, done - is the work-order machinery, so the first time
 * the manager sends an add-on to vendors we create ONE work order that serves it:
 *
 *   add-on.linkedWorkOrderId  ->  work order id
 *   work order.linkedServiceRequestId  ->  add-on id
 *
 * The two models stay separate (AGENTS.md: never merge the tables, tabs or counts):
 *   - the resident's charge stays on the add-on ONLY. The vendor job has no resident, no resident email and
 *     never a resident charge (`workOrderMayBillResident`), only the vendor's bill;
 *   - the job is the manager's own record, so the Services lists never draw it as a service of its own
 *     (`withoutLinkedVendorJobs`);
 *   - an offered vendor sees the job's general area only (`projectWorkOrderForOfferedVendor`).
 * The add-on's Vendors section reads this job's offers and bids, and its stage follows the job once a
 * vendor is hired (`applyVendorJobToAddOn`).
 */
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ServiceRequest } from "@/lib/service-requests-storage";

/** The work order that serves an add-on: deterministic, so a retried first send never makes a second one. */
export function addOnVendorJobId(addOnId: string): string {
  return `${addOnId.trim()}-vendor-job`;
}

type LinkedFlag = { linkedServiceRequestId?: string | null };

/** True for the vendor job behind an add-on. */
export function isLinkedVendorJob(row: LinkedFlag | null | undefined): boolean {
  return Boolean(row?.linkedServiceRequestId?.trim());
}

/** The Services lists show real services only: drop every add-on's vendor job. */
export function withoutLinkedVendorJobs<T extends LinkedFlag>(rows: readonly T[]): T[] {
  return rows.filter((row) => !isLinkedVendorJob(row));
}

/**
 * The one guard every client charge generator reads before billing a resident for a work order. A linked
 * vendor job never bills a resident (the add-on carries that charge) - and it has no resident to bill.
 */
export function workOrderMayBillResident(row: LinkedFlag | null | undefined): boolean {
  return !isLinkedVendorJob(row);
}

export function linkedVendorJobFor(
  req: Pick<ServiceRequest, "id" | "linkedWorkOrderId">,
  rows: readonly DemoManagerWorkOrderRow[],
): DemoManagerWorkOrderRow | null {
  const byLink = req.linkedWorkOrderId?.trim();
  if (byLink) {
    const found = rows.find((row) => row.id === byLink);
    if (found) return found;
  }
  return rows.find((row) => row.linkedServiceRequestId === req.id) ?? null;
}

/**
 * The job we hand to vendors for an add-on: its description, the property and the area - and nothing
 * about the resident. No `residentEmail` / `residentName` / `residentChargeCents`, so no charge generator
 * has anything to bill.
 */
export function buildAddOnVendorJobRow(
  req: Pick<ServiceRequest, "id" | "offerName" | "offerDescription" | "notes" | "propertyId">,
  ctx: { propertyName: string; propertyAddress?: string; managerUserId: string | null; now?: Date },
): DemoManagerWorkOrderRow {
  const title = req.offerName?.trim() || "Service";
  const details = req.offerDescription?.trim() || req.notes?.trim() || title;
  return {
    id: addOnVendorJobId(req.id),
    propertyName: ctx.propertyName.trim() || "Property",
    ...(ctx.propertyAddress?.trim() ? { propertyAddress: ctx.propertyAddress.trim() } : {}),
    unit: "",
    title,
    priority: "Medium",
    status: "Open",
    bucket: "open",
    description: details,
    scheduled: "",
    cost: "",
    category: "general",
    propertyId: req.propertyId?.trim() || undefined,
    managerUserId: ctx.managerUserId,
    managerInitiated: true,
    linkedServiceRequestId: req.id,
  };
}

/**
 * The add-on as the record should read once a vendor is on its job: the hired vendor becomes the
 * assignee, the job's visit time the visit, and a finished job completes an approved add-on. Pure and
 * read-only - nothing is written back - so a vendor marking the job done elsewhere shows up here too.
 */
export function applyVendorJobToAddOn(req: ServiceRequest, job: DemoManagerWorkOrderRow | null | undefined): ServiceRequest {
  if (!job || !isLinkedVendorJob(job)) return req;
  let next = req;
  if (!req.assignee && job.vendorId?.trim()) {
    next = { ...next, assignee: { type: "vendor", id: job.vendorId.trim(), name: job.vendorName?.trim() || "Vendor" } };
  }
  if (!req.proposedVisit && job.scheduledAtIso) {
    next = { ...next, proposedVisit: { iso: job.scheduledAtIso, source: "availability" } };
  }
  // A vendor's own "mark done" is their claim, not the manager's confirmation: it shows as
  // "Vendor says done" and the manager's Mark done is what finishes the add-on (and returns a
  // deposit). Only a completion the manager ran closes the request here.
  const finished = job.bucket === "completed" || job.automationStatus === "paid";
  if (finished && req.status === "approved" && (job.status ?? "").trim().toLowerCase() !== "cancelled") {
    next = { ...next, status: "returned" };
  }
  return next;
}
