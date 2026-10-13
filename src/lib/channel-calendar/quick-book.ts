import { parseRoomChoiceValue } from "@/lib/rental-application/room-choice-value";
import { addDaysToDateKey } from "@/lib/channel-calendar/bookings-ui";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import type { DemoApplicantRow } from "@/data/demo-portal";

/** What the Block dates sheet opens on when a manager books straight from an application. */
export type QuickBookPrefill = {
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  resident: { name: string; email: string; phone: string };
  reason: string;
};

const DAY_KEY = /^\d{4}-\d{2}-\d{2}/;

/**
 * Quick book is offered while the application is LIVE: pending or approved, never declined, and never a
 * row the resident withdrew or never finished — both of those keep `bucket: "pending"`, and holding a room
 * for one would email the applicant a resident invite for an application that is not standing.
 */
export function applicationRowCanQuickBook(row: DemoApplicantRow): boolean {
  // `isDraftShapedApplicationRow` is the draft half of `isInProgressApplicationRow`, read straight from
  // the shared vocabulary so this module stays free of the browser-side applications store.
  if (isWithdrawnApplicationRow(row) || isDraftShapedApplicationRow(row)) return false;
  return row.bucket === "pending" || row.bucket === "approved";
}

/** Null when the application names no room or no move-in date: there is nothing to hold. */
export function quickBookPrefillForApplication(row: DemoApplicantRow): QuickBookPrefill | null {
  const application = row.application;
  if (!application) return null;
  const choice = parseRoomChoiceValue(application.roomChoice1 ?? "");
  const propertyId = (choice.propertyId ?? row.propertyId ?? "").trim();
  const roomId = choice.listingRoomId ?? "";
  const start = DAY_KEY.test(application.leaseStart ?? "") ? application.leaseStart.slice(0, 10) : "";
  if (!propertyId || !start) return null;
  const end = DAY_KEY.test(application.leaseEnd ?? "") ? application.leaseEnd.slice(0, 10) : "";
  return {
    propertyId,
    roomId,
    checkIn: start,
    checkOut: end && end > start ? end : addDaysToDateKey(start, 1),
    resident: { name: row.name ?? "", email: row.email ?? "", phone: application.phone ?? "" },
    reason: `Application ${row.id}`,
  };
}
