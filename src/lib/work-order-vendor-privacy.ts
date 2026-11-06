import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderBid } from "@/lib/work-order-bids";
import { formatServiceVisitLabel } from "@/lib/schedule-service-visit";
import type { ServiceWorkflowStep } from "@/lib/manager-service-workflow";
import { SMS_TEST_PROVENANCE_ROW_KEYS } from "@/lib/sms/sms-test-provenance";

/** A bare two-letter state, optionally with its ZIP: "WA", "WA 98101", "WA 98101-1234". */
const STATE_PART = /^[A-Za-z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/;
/** A country tail an address may end with; dropped before the city is read. */
const COUNTRY_PART = /^(?:USA|U\.S\.A\.?|US|U\.S\.?|United States(?: of America)?|CA|CAN|Canada)$/i;
/**
 * A city name: letters, spaces and the punctuation real names carry ("St. Louis", "Coeur d'Alene",
 * "Winston-Salem"). A street line is rejected by its leading house number and by its thoroughfare
 * word, tested on whole words so "St. Louis" and "St. Paul" survive while "Main St" does not.
 */
const CITY_SHAPE = /^[A-Za-z][A-Za-z .'-]*$/;
/**
 * A secondary-unit designator or a thoroughfare word. A part carrying either is an address LINE,
 * never a city, so it can never become the general area.
 *
 * Only designators that cannot also be a city-name word are listed. `ste`, `upper`, `lower`, `rear`,
 * `front`, `block` and `key` are deliberately absent: Ste. Genevieve, Upper Darby, Lower Burrell,
 * Rear, Front Royal, Block Island and Key West are real places, and rejecting them would collapse a
 * legitimate city to "Nearby".
 */
const STREET_WORD = /(?:^|\s)(?:unit|suite|apt|apartment|floor|fl|rm|room|bldg|building|penthouse|lot|space|spc|trailer|slip|hangar|pier|basement|bsmt|dept|department|street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl|terrace|ter|way|hwy|highway|pkwy|parkway|circle|cir)\.?(?:\s|$)/i;

function cityLikePart(value: string | undefined): string {
  const part = value?.trim() ?? "";
  if (!part || !CITY_SHAPE.test(part)) return "";
  // "St. Louis" is a city; "Main St" is a street. Only a trailing thoroughfare word disqualifies.
  if (STREET_WORD.test(` ${part.replace(/^St\.?\s+/i, "")} `)) return "";
  return part;
}

/**
 * Vendors see a general area before hire — never the street address or entry notes.
 *
 * The city (with its state when the address carries one) is the useful, non-identifying answer: a
 * vendor browsing leads has to know which city a job is in to bid at all. Requiring three comma
 * parts whose last one was a bare state collapsed "123 Main St, Seattle" and
 * "123 Main St, Seattle, WA 98101, USA" alike to "Nearby". So a trailing country is dropped first,
 * a trailing state is kept beside the city, and two parts are enough.
 *
 * `propertyName` is never a fallback: a distinctive house name identifies the property as surely as
 * its street. No derivable city means "Nearby".
 */
export function workOrderGeneralArea(row: Pick<DemoManagerWorkOrderRow, "propertyAddress" | "propertyName">): string {
  const addr = row.propertyAddress?.trim();
  if (!addr) return "Nearby";
  const parts = addr.split(",").map((p) => p.trim()).filter(Boolean);
  while (parts.length > 2 && COUNTRY_PART.test(parts.at(-1) ?? "")) parts.pop();
  if (parts.length < 2) return "Nearby";
  const last = parts.at(-1) ?? "";
  if (STATE_PART.test(last)) {
    // The part before the state is the city — unless it is the street line itself ("123 Main St,
    // WA"), which `cityLikePart` rejects on its house number and thoroughfare word. The ZIP is
    // dropped: a ZIP narrows the area to a few blocks.
    const city = cityLikePart(parts[parts.length - 2]);
    return city ? `${city}, ${last.replace(/\s+\d{5}(?:-\d{4})?$/, "")}` : "Nearby";
  }
  // No state part: the last component is the city ("123 Main St, Seattle").
  const city = cityLikePart(last);
  return city || "Nearby";
}

/** Offered rows carry the area computed by the server projection. */
export function vendorVisibleGeneralArea(row: DemoManagerWorkOrderRow): string {
  return row.offeredGeneralArea || workOrderGeneralArea(row);
}

/** After hire the vendor sees the full site (address, resident, entry). */
export function vendorCanSeeFullWorkOrderSite(
  row: DemoManagerWorkOrderRow,
  bid?: WorkOrderBid | null,
): boolean {
  if (bid?.status === "accepted") return true;
  if (row.vendorAssignedAt && row.vendorId && !row.biddingOpen) return true;
  if (row.bucket === "scheduled" || row.bucket === "completed") {
    return Boolean(row.vendorId || row.vendorName);
  }
  return false;
}

export function vendorServiceWorkflowSteps(
  row: DemoManagerWorkOrderRow,
  bid?: WorkOrderBid | null,
): ServiceWorkflowStep[] {
  const hired = vendorCanSeeFullWorkOrderSite(row, bid);
  const quoted = Boolean(bid);
  const scheduled = Boolean(row.scheduledAtIso);
  const done = row.bucket === "completed" || Boolean(row.completedAt);
  const paid = row.automationStatus === "paid";

  const raw = [
    { id: "lead", label: "Lead", done: true, detail: vendorVisibleGeneralArea(row) },
    { id: "quoted", label: "Quoted", done: quoted, detail: "" },
    { id: "hired", label: "Hired", done: hired, detail: "" },
    {
      id: "scheduled",
      label: "Scheduled",
      done: scheduled || done,
      detail: row.scheduledAtIso ? formatServiceVisitLabel(row.scheduledAtIso) : "",
    },
    { id: "done", label: "Done", done, detail: "" },
    { id: "paid", label: "Paid", done: paid, detail: "" },
  ];

  let currentIdx = raw.findIndex((s) => !s.done);
  if (currentIdx < 0) currentIdx = raw.length - 1;

  return raw.map((step, idx) => ({
    id: step.id,
    label: step.label,
    detail: step.detail,
    state: idx < currentIdx ? "done" : idx === currentIdx ? "current" : "todo",
  }));
}

export function vendorLeadMapsQuery(row: DemoManagerWorkOrderRow): string {
  const area = vendorVisibleGeneralArea(row);
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(area)}`;
}

/**
 * Keys a vendor read must never carry, stripped at every depth of the stored payload.
 *
 * The row's own subjects, plus the whole SMS-test provenance family — taken from
 * `SMS_TEST_PROVENANCE_ROW_KEYS` rather than re-typed here, so a new spelling accepted by
 * `readSmsTestProvenance` cannot be stripped by the writer and still reach a vendor. That
 * stamp is operator provenance: the actor's Auth id, their session and the test workspace.
 */
const VENDOR_PRIVATE_SUBJECT_KEYS = new Set<string>([
  "residentUserId", "managerUserId", "vendorUserId",
  "resident_user_id", "manager_user_id", "vendor_user_id",
  "userId", "user_id", "actorUserId", "actor_user_id",
  "sessionId", "session_id", "workspaceId", "workspace_id",
  "resident_email", "dispatch", "candidates",
  "sms_test_provenance",
  ...SMS_TEST_PROVENANCE_ROW_KEYS,
]);

/** A vendor-directory ID must belong to this viewer and this job's manager. */
export function assignedVendorDirectoryId(rowId: unknown, managerId: string, viewerId: string, directory: Array<{ id: string; managerId: string }>, residentId?: string | null): string | null {
  const ids = [...new Set(directory.filter((item) => item.managerId === managerId && item.id !== viewerId && item.id !== managerId && item.id !== residentId).map((item) => item.id))];
  if (typeof rowId === "string" && ids.includes(rowId)) return rowId;
  return ids.length === 1 ? ids[0]! : null;
}

export function normalizeAssignedVendorAssignee(row: DemoManagerWorkOrderRow, vendorId: string): DemoManagerWorkOrderRow["assignee"] {
  return row.assignee?.type === "vendor" ? { ...row.assignee, id: vendorId } : row.assignee;
}

/**
 * A job the viewer HOLDS (`vendor_user_id` is them) whose directory id cannot be resolved under its
 * manager — their roster row was removed while the job was in flight, or they have two of them.
 *
 * The job is still theirs and is still served; only the identity that could not be verified is
 * withheld. The stored `vendorId` and the assignee id go, because an unverified value there may be
 * an Auth subject rather than a directory record.
 */
export function withheldAssignedVendorIdentity(row: DemoManagerWorkOrderRow, managerId: string): DemoManagerWorkOrderRow {
  const { vendorId: _unverified, ...rest } = row;
  return {
    ...rest,
    managerUserId: managerId,
    ...(row.assignee?.type === "vendor" ? { assignee: { type: "vendor" as const, id: "", name: row.assignee.name } } : {}),
  };
}

/** Strip Auth subjects from the entire stored payload while retaining opaque job/directory IDs. */
function withoutAuthSubjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAuthSubjects);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !VENDOR_PRIVATE_SUBJECT_KEYS.has(key) && !(row.type === "team" && key === "id")).map(([key, child]) => [key, withoutAuthSubjects(child)]));
}

/**
 * The shape an OFFERED-but-not-hired vendor is allowed to receive, applied on the server
 * before the row ever leaves the API (`/api/portal-work-orders`). The helpers above decide
 * what the vendor portal DRAWS; this decides what it is given, which is the access control.
 *
 * Nothing identifying the site survives: the street address, the unit, entry notes and
 * permission, the resident's name and email, and the resident's intake photos unless the
 * manager ticked "Share photos" on the bid request. `propertyName` is replaced with the
 * general area so every downstream label keeps reading the area and nothing else.
 *
 * What the manager bills the RESIDENT for the job goes too. It is the manager's markup over the
 * bid the vendor is about to submit, and a vendor who has only been offered the job has no
 * business reading it.
 *
 * So does the job's recorded vendor price. On a service re-offered after its hired vendor went
 * silent, those fields still hold THAT vendor's approved figure — handing it to the competitors
 * now being asked to bid against it.
 */
export function projectWorkOrderForOfferedVendor(row: DemoManagerWorkOrderRow): DemoManagerWorkOrderRow {
  const area = workOrderGeneralArea(row);
  const {
    propertyAddress: _propertyAddress,
    entryNotes: _entryNotes,
    entryPermission: _entryPermission,
    residentName: _residentName,
    residentEmail: _residentEmail,
    residentConfirmation: _residentConfirmation,
    residentChargeCents: _residentChargeCents,
    residentChargeId: _residentChargeId,
    residentReminderSentAt: _residentReminderSentAt,
    expenseEntryIds: _expenseEntryIds,
    // The add-on this vendor job serves is the manager's own record; the vendor only ever sees the job.
    linkedServiceRequestId,
    cost: _cost,
    vendorCostCents: _vendorCostCents,
    materialsCostCents: _materialsCostCents,
    vendorPriceSetAt: _vendorPriceSetAt,
    photoDataUrls,
    vendorId: _vendorId,
    vendorAssignedAt: _vendorAssignedAt,
    assignee: _assignee,
    ...rest
  } = row;
  // An add-on's vendor job carries only what the manager published. A row saved before that rule may still hold
  // the resident's own notes in `description`, so an offered vendor reads the service title and nothing more.
  const isAddOnJob = Boolean(linkedServiceRequestId?.trim());
  // `assignedRoomChoice` is not on the typed row but can ride a work order's payload; it names a room.
  const offered = { ...rest } as Record<string, unknown>;
  delete offered.assignedRoomChoice;
  delete offered.generalArea;
  delete offered.preferredArrival;
  for (const key of ["propertyId", "assignedPropertyId", "workspaceId", "property_id", "assigned_property_id", "workspace_id"]) delete offered[key];
  return {
    ...(withoutAuthSubjects(offered) as typeof rest),
    propertyName: area,
    offeredGeneralArea: area,
    unit: "—",
    cost: "",
    ...(isAddOnJob ? { description: row.title } : {}),
    ...(row.offerSharePhotos === true && photoDataUrls?.length ? { photoDataUrls } : {}),
  };
}

/**
 * What a HIRED vendor receives. They hold the job, so the site stays, but the manager's billing
 * of the RESIDENT (charge amount and id, the expense entries that settled it, the resident's
 * confirmation) is the manager's own ledger and never leaves the server on a vendor read.
 */
export function projectWorkOrderForHiredVendor(row: DemoManagerWorkOrderRow): DemoManagerWorkOrderRow {
  const {
    residentChargeCents: _residentChargeCents,
    residentChargeId: _residentChargeId,
    expenseEntryIds: _expenseEntryIds,
    residentConfirmation: _residentConfirmation,
    residentReminderSentAt: _residentReminderSentAt,
    ...rest
  } = row;
  return withoutAuthSubjects(rest) as DemoManagerWorkOrderRow;
}
