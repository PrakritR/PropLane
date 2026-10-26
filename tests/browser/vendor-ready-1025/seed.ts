/**
 * Fixture rows for the vendor-ready browser proof. One manager (Taylor M.) and one
 * vendor (Harbor Plumbing): a job at each service stage, two completed jobs whose
 * completion photos arrived the new way (a private-bucket path) and the old way
 * (inline base64), the vendor's assigned tasks, their conversation with the manager,
 * and one approved vendor bill waiting to be paid.
 *
 * Every row is the REAL shape the panels read: `DemoManagerWorkOrderRow` as
 * `/api/portal-work-orders` returns it, `VendorAssignedTask` as
 * `/api/vendor/tasks` returns it, `OutgoingInvoice` as
 * `/api/manager/vendor-invoices` returns it.
 */
import type { DemoManagerWorkOrderRow } from "../../../src/data/demo-portal";
import { formatInboxStamp } from "../../../src/lib/portal-inbox-storage";

export const MANAGER_ID = "mgr-taylor";
export const MANAGER_NAME = "Taylor M.";
export const VENDOR_ID = "vnd-harbor";
export const VENDOR_USER_ID = "usr-harbor";
export const VENDOR_NAME = "Harbor Plumbing";
export const VENDOR_DIRECTORY_ID = "vrec-harbor";
export const PROPERTY_ID = "prop-magnolia";

/** A real 64x48 solid-blue JPEG (sharp-encoded): the completion-photo bytes the fake bucket holds. */
export const PHOTO_JPEG_DATA_URL =
  "data:image/jpeg;base64,/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAwAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmAG+QgAAAAAAAAAAAAAAAAAAAAAH/9k=";

function base(id: string, title: string): DemoManagerWorkOrderRow {
  return {
    id,
    reference: id.toUpperCase(),
    propertyName: "The Magnolia",
    propertyAddress: "1420 Magnolia Ave, Seattle, WA 98122",
    unit: "Room 2",
    title,
    priority: "Normal",
    status: "Open",
    bucket: "open",
    description: "Kitchen sink backs up when the dishwasher drains.",
    scheduled: "",
    cost: "",
    propertyId: PROPERTY_ID,
    managerUserId: MANAGER_ID,
    managerName: MANAGER_NAME,
    vendorId: VENDOR_ID,
    vendorName: VENDOR_NAME,
    vendorUserId: VENDOR_USER_ID,
    category: "plumbing",
    residentName: "Maya R.",
    entryPermission: "allowed",
  };
}

/** Assigned: the vendor's bid was approved and no visit time exists yet — the stage that owns the schedule picker. */
export function assignedJob(): DemoManagerWorkOrderRow {
  return {
    ...base("wo-assigned", "Kitchen sink keeps clogging"),
    status: "Assigned",
    bucket: "open",
    vendorAssignedAt: "2026-10-24T18:00:00.000Z",
    vendorCostCents: 18_000,
  };
}

/** Scheduled: a visit time exists, so the vendor's next step is Complete (photo required). */
export function scheduledJob(): DemoManagerWorkOrderRow {
  return {
    ...base("wo-scheduled", "Water heater pressure valve"),
    status: "Scheduled",
    bucket: "scheduled",
    scheduled: "Mon, Oct 27 · 9am",
    scheduledAtIso: "2026-10-27T16:00:00.000Z",
    vendorAssignedAt: "2026-10-20T18:00:00.000Z",
    vendorCostCents: 24_000,
  };
}

/**
 * Completed, with the completion photo in the PRIVATE bucket (a path, not bytes):
 * the manager's service record has to reach it through a signed URL.
 */
export function completedJobPrivatePhoto(): DemoManagerWorkOrderRow {
  return {
    ...base("wo-done-private", "Hallway radiator bleed"),
    status: "Completed",
    bucket: "completed",
    scheduled: "Fri, Oct 24 · 1pm",
    scheduledAtIso: "2026-10-24T20:00:00.000Z",
    automationStatus: "vendor_marked_done",
    vendorMarkedDoneAt: "2026-10-24T22:10:00.000Z",
    vendorMarkedDoneNote: "Bled both radiators, pressure back to 1.4 bar.",
    completedAt: "2026-10-24T22:10:00.000Z",
    completionPhotoPaths: [`manager/${MANAGER_ID}/service-completion/wo-done-private/1761350000000-0.jpg`],
    vendorCostCents: 14_500,
  };
}

/** Completed the OLD way: the photo bytes are still inline on the row. It must still render. */
export function completedJobLegacyPhoto(): DemoManagerWorkOrderRow {
  return {
    ...base("wo-done-legacy", "Laundry room drain snake"),
    status: "Completed",
    bucket: "completed",
    scheduled: "Tue, Sep 30 · 10am",
    scheduledAtIso: "2026-09-30T17:00:00.000Z",
    automationStatus: "vendor_marked_done",
    vendorMarkedDoneAt: "2026-09-30T19:00:00.000Z",
    completedAt: "2026-09-30T19:00:00.000Z",
    completionPhotoDataUrls: [PHOTO_JPEG_DATA_URL],
    vendorCostCents: 9_000,
  };
}

export function vendorJobs(): DemoManagerWorkOrderRow[] {
  return [assignedJob(), scheduledJob(), completedJobPrivatePhoto()];
}

/** `/api/vendor/tasks` rows: the vendor's own checklist, assigned by the manager. */
export function vendorTasks() {
  const task = (id: string, title: string, completed: boolean, start?: string) => ({
    id,
    title,
    completed,
    createdAt: "2026-10-20T18:00:00.000Z",
    start: start ?? null,
    end: start ? new Date(Date.parse(start) + 3_600_000).toISOString() : null,
    dueDate: null,
    notes: "",
    propertyId: PROPERTY_ID,
    propertyTitle: "The Magnolia",
    assignee: { type: "vendor" as const, id: VENDOR_DIRECTORY_ID, name: VENDOR_NAME },
    managerUserId: MANAGER_ID,
    managerName: MANAGER_NAME,
    vendorDirectoryId: VENDOR_DIRECTORY_ID,
  });
  return [
    task("task-filters", "Replace furnace filters — all four units", false, "2026-10-27T17:00:00.000Z"),
    task("task-gutters", "Clear the back gutters before the storm", false, "2026-10-29T16:00:00.000Z"),
    task("task-shutoff", "Label the basement water shutoff", true, "2026-10-14T17:00:00.000Z"),
  ];
}

/** One approved vendor bill in the manager's Outgoing list, ready to pay. */
export function outgoingInvoice() {
  return {
    id: "inv-harbor-1",
    invoiceNumber: "HP-1042",
    vendorUserId: VENDOR_USER_ID,
    vendorName: VENDOR_NAME,
    workOrderId: "wo-done-private",
    serviceTitle: "Hallway radiator bleed",
    propertyName: "The Magnolia",
    vendorId: VENDOR_DIRECTORY_ID,
    status: "approved" as const,
    totalCents: 14_500,
    subtotalCents: 14_500,
    taxCents: 0,
    currency: "usd",
    memo: "Radiator bleed + pressure reset",
    decisionNote: null,
    billId: null,
    paidFrom: null,
    managerUserId: MANAGER_ID,
    lineItems: [
      { description: "Labor (1.5 hrs)", quantity: 1, amountCents: 12_000 },
      { description: "Bleed key + fittings", quantity: 1, amountCents: 2_500 },
    ],
    submittedAt: "2026-10-24T23:00:00.000Z",
    decidedAt: "2026-10-25T16:00:00.000Z",
    scheduledFor: null,
    paidAt: null,
  };
}

/**
 * The vendor's Communication thread with their manager, as `/api/portal-inbox-threads`
 * returns it: the manager's message is already in the vendor's own PropLane inbox.
 */
export function vendorInboxThread() {
  return {
    id: "thr-taylor",
    folder: "inbox" as const,
    from: MANAGER_NAME,
    email: "taylor@example.com",
    subject: "Hallway radiator bleed",
    preview: "Can you take a look at the radiator this week?",
    body: "Can you take a look at the radiator this week?",
    // Every inbox stamp is `formatInboxStamp` (Pacific) — it is both the label and the sort key.
    time: formatInboxStamp(new Date("2026-10-25T16:05:00.000Z")),
    rootAt: "2026-10-25T16:05:00.000Z",
    rootChannel: "proplane" as const,
    unread: true,
    messages: [
      {
        id: "msg-1",
        from: MANAGER_NAME,
        body: "Can you take a look at the radiator this week?",
        at: "2026-10-25T16:05:00.000Z",
        outbound: false,
        channel: "proplane" as const,
      },
    ],
  };
}
