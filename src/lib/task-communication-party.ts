import type { DemoApplicantRow } from "@/data/demo-portal";
import { resolveApplicationPersonalFields } from "@/lib/application-personal-fields";
import type { ManagerTask } from "@/lib/manager-tasks";

/**
 * Who a task's Communication thread is with. The task page already holds the data this reads
 * (applications, planned tour events, services, vendors, leases), so this is a pure lookup, never a
 * request. It returns the one person the task is about; `null` means nobody, and the task's
 * Communication is then the workspace Team chat only.
 */
export type TaskCommunicationParty = {
  name: string;
  emails: string[];
  phone: string | null;
  role: "prospect" | "applicant" | "resident" | "vendor";
};

export type TaskCommunicationSources = {
  applications?: Array<Pick<DemoApplicantRow, "id" | "name" | "email" | "application" | "bucket" | "axisId">>;
  /** Planned events; a tour carries its guest as `attendee*`. */
  tours?: Array<{
    id: string;
    sourceInquiryId?: string;
    attendeeName?: string;
    attendeeEmail?: string;
    attendeePhone?: string;
  }>;
  /** Services (work orders) the task may be linked to. */
  workOrders?: Array<{
    id: string;
    vendorId?: string;
    vendorName?: string;
    assignee?: { type: string; id: string; name: string };
    residentName?: string;
    residentEmail?: string;
  }>;
  vendors?: Array<{ id: string; name: string; email?: string; phone?: string }>;
  /** Lease pipeline rows: a countersign task's `sourceId` is the lease id. */
  leases?: Array<{ id: string; residentName?: string; residentEmail?: string; axisId?: string }>;
};

const APPLICATION_TEMPLATES = new Set([
  "review_application",
  "decide_application",
  "review_and_send_lease",
  "countersign_lease",
  "collect_rent",
]);
const TOUR_TEMPLATES = new Set(["approve_tour_request", "prepare_for_tour"]);

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function uniqueEmails(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const email = clean(value).toLowerCase();
    if (email.includes("@") && !out.includes(email)) out.push(email);
  }
  return out;
}

function party(
  role: TaskCommunicationParty["role"],
  name: string | undefined,
  emails: Array<string | null | undefined>,
  phone: string | undefined,
): TaskCommunicationParty | null {
  const list = uniqueEmails(emails);
  const digits = clean(phone);
  // A person with neither an email nor a number cannot be reached, so there is no thread to show.
  if (list.length === 0 && !digits) return null;
  return { name: clean(name) || list[0] || digits, emails: list, phone: digits || null, role };
}

/** `<applicationId>-initial-rent` (collect_rent) is the application's id with a suffix. */
function applicationIdFromSource(sourceId: string): string {
  return sourceId.replace(/-initial-rent$/, "");
}

function fromTour(task: ManagerTask, sources: TaskCommunicationSources): TaskCommunicationParty | null {
  const ids = [task.linkedTourId, task.sourceId].map(clean).filter(Boolean);
  const tour = (sources.tours ?? []).find(
    (event) => ids.includes(event.id) || (event.sourceInquiryId ? ids.includes(event.sourceInquiryId) : false),
  );
  if (!tour) return null;
  return party("prospect", tour.attendeeName, [tour.attendeeEmail], tour.attendeePhone);
}

function fromApplication(
  task: ManagerTask,
  sources: TaskCommunicationSources,
  role: "applicant" | "resident",
): TaskCommunicationParty | null {
  const sourceId = clean(task.sourceId);
  if (!sourceId) return null;
  const appId = applicationIdFromSource(sourceId);
  const row = (sources.applications ?? []).find((app) => app.id === appId || app.axisId === appId);
  if (row) {
    const personal = resolveApplicationPersonalFields(row);
    return party(role, personal.fullLegalName, [personal.email], personal.phone);
  }
  // countersign_lease's source is the lease, which names the resident but carries no phone.
  const lease = (sources.leases ?? []).find((item) => item.id === sourceId || item.id === appId);
  if (lease) return party(role, lease.residentName, [lease.residentEmail], undefined);
  return null;
}

function fromService(task: ManagerTask, sources: TaskCommunicationSources): TaskCommunicationParty | null {
  const order = (sources.workOrders ?? []).find((row) => row.id === clean(task.linkedWorkOrderId));
  const vendorId =
    (order?.assignee?.type === "vendor" ? order.assignee.id : undefined) ||
    order?.vendorId ||
    (task.assignee?.type === "vendor" ? task.assignee.id : undefined);
  if (!vendorId) return null;
  const vendor = (sources.vendors ?? []).find((row) => row.id === vendorId);
  if (!vendor) return null;
  return party("vendor", vendor.name || order?.vendorName, [vendor.email], vendor.phone);
}

export function resolveTaskCommunicationParty(
  task: Pick<ManagerTask, "taskType" | "linkedTourId" | "linkedWorkOrderId" | "templateKey" | "sourceId" | "assignee">,
  sources: TaskCommunicationSources,
): TaskCommunicationParty | null {
  const template = clean(task.templateKey);
  const full = task as ManagerTask;

  if (task.taskType === "tour" || clean(task.linkedTourId) || TOUR_TEMPLATES.has(template)) {
    return fromTour(full, sources);
  }
  if (APPLICATION_TEMPLATES.has(template)) {
    // The applicant until a lease is signed; the resident once it is being countersigned or paid.
    const role = template === "countersign_lease" || template === "collect_rent" ? "resident" : "applicant";
    return fromApplication(full, sources, role);
  }
  if (task.taskType === "work_order" || clean(task.linkedWorkOrderId)) {
    return fromService(full, sources);
  }
  if (task.taskType === "check_in" || task.taskType === "check_out") {
    return fromApplication(full, sources, "resident");
  }
  return null;
}
