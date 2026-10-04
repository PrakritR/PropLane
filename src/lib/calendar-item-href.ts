/**
 * Where a calendar item opens: the record behind it (studio plan claude-2/services-vendors-1004,
 * Calendar). Pure: nothing here reads storage, the caller hands in lookups for the one thing a
 * meeting does not carry (the bucket of the record it points at).
 *
 *   service  -> workOrderDetailHref / serviceRequestDetailHref (bucket from the source record)
 *   tour     -> managerTourDetailHref
 *   task     -> managerTaskDetailHref
 *   booking  -> bookingRecordHref
 *
 * A meeting whose record cannot be resolved (a Google event, a service whose row is gone) returns
 * null so the caller keeps the quick-look dialog rather than building a dead link.
 */
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { workOrderServiceStage } from "@/lib/service-lifecycle";
import {
  bookingRecordHref,
  managerTaskDetailHref,
  managerTourDetailHref,
  serviceRequestDetailHref,
  workOrderDetailHref,
  type ManagerTaskListTabId,
  type ManagerTourBucketId,
  type ServiceRequestBucketId,
  type WorkOrderBucketId,
} from "@/lib/portal-detail-routes";

export type CalendarRecordTarget =
  | { kind: "work-order"; id: string; bucket: WorkOrderBucketId }
  | { kind: "service-request"; id: string; bucket: ServiceRequestBucketId }
  | { kind: "tour"; id: string; bucket: ManagerTourBucketId }
  | { kind: "task"; id: string; tab: ManagerTaskListTabId }
  | { kind: "booking"; id: string };

export function calendarRecordHref(basePath: string, target: CalendarRecordTarget): string {
  switch (target.kind) {
    case "work-order":
      return workOrderDetailHref(basePath, target.bucket, target.id);
    case "service-request":
      return serviceRequestDetailHref(basePath, target.bucket, target.id);
    case "tour":
      return managerTourDetailHref(basePath, target.bucket, target.id);
    case "task":
      return managerTaskDetailHref(basePath, target.tab, target.id);
    case "booking":
      return bookingRecordHref(basePath, target.id);
  }
}

/**
 * The Services tab a work order sits on RIGHT NOW: the same stage the Services list files it under
 * (`workOrderServiceStage`), never the status a meeting was created with. A service finished since
 * the visit was booked is Completed, so its calendar item opens `/completed/<id>`, not `/scheduled/<id>`.
 */
export function workOrderRecordBucket(
  row: DemoManagerWorkOrderRow,
  data: Parameters<typeof workOrderServiceStage>[1] = { bids: [], offers: [] },
): WorkOrderBucketId {
  return workOrderServiceStage(row, data);
}

/** The bucket of a record, read from its own row. Every lookup is optional and may answer undefined. */
export type CalendarRecordLookup = {
  workOrderBucket?: (id: string) => WorkOrderBucketId | undefined;
  serviceRequestBucket?: (id: string) => ServiceRequestBucketId | undefined;
  /** The Tasks tab the task sits on; Open when the task is not found (the page finds it by id). */
  taskTab?: (id: string) => ManagerTaskListTabId | undefined;
};

/** A planned tour is Pending until the manager confirms, Past once it has ended, else Upcoming. */
export function calendarTourBucket(meeting: Pick<DemoMeeting, "source" | "endIso">, nowMs: number): ManagerTourBucketId {
  if (meeting.source === "inquiry") return "pending";
  const end = Date.parse(meeting.endIso);
  return Number.isFinite(end) && end < nowMs ? "past" : "upcoming";
}

export function meetingRecordTarget(
  meeting: DemoMeeting,
  lookup: CalendarRecordLookup = {},
  nowMs: number = Date.now(),
): CalendarRecordTarget | null {
  if (meeting.googleCalendarPrivate || meeting.googleCalendarInformational) return null;

  if (meeting.kind === "task") {
    if (!meeting.sourceTaskId) return null;
    return { kind: "task", id: meeting.sourceTaskId, tab: lookup.taskTab?.(meeting.sourceTaskId) ?? "open" };
  }

  if (meeting.kind === "tour" || meeting.kind === "partner") {
    if (meeting.source === "external" || !meeting.sourceId) return null;
    return { kind: "tour", id: meeting.sourceId, bucket: calendarTourBucket(meeting, nowMs) };
  }

  if (meeting.kind === "service") {
    if (meeting.source !== "external" || !meeting.sourceId || !meeting.id.startsWith("manager-service-")) return null;
    const workOrder = lookup.workOrderBucket?.(meeting.sourceId);
    if (workOrder) return { kind: "work-order", id: meeting.sourceId, bucket: workOrder };
    const request = lookup.serviceRequestBucket?.(meeting.sourceId);
    if (request) return { kind: "service-request", id: meeting.sourceId, bucket: request };
    return null;
  }

  return null;
}

/** The href a meeting opens, or null when the quick-look dialog is the only honest answer. */
export function meetingRecordHref(
  basePath: string,
  meeting: DemoMeeting,
  lookup: CalendarRecordLookup = {},
  nowMs: number = Date.now(),
): string | null {
  const target = meetingRecordTarget(meeting, lookup, nowMs);
  return target ? calendarRecordHref(basePath, target) : null;
}
