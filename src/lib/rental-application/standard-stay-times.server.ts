import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { loadPropertyStayClock } from "@/lib/bookings/property-stay-times.server";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";

/** Applicant payloads cannot negotiate the host's arrival/departure clock. */
export async function standardizeApplicantStayTimes(
  db: SupabaseClient,
  row: DemoApplicantRow,
  existing?: DemoApplicantRow | null,
): Promise<DemoApplicantRow> {
  if (row.application?.rentalType !== "short_term") return row;
  // A previously submitted application's stored clock is historical evidence.
  // Preserve it even when defaults change, and never echo a replacement from the client.
  if (existing?.application && !isDraftShapedApplicationRow(existing)) {
    return { ...row, application: { ...row.application,
      shortTermCheckInTime: existing.application.shortTermCheckInTime,
      shortTermCheckOutTime: existing.application.shortTermCheckOutTime,
    } };
  }
  const propertyId = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application.propertyId?.trim() || null;
  const { times } = await loadPropertyStayClock(db, propertyId);
  return { ...row, application: { ...row.application,
    shortTermCheckInTime: times.checkInTime,
    shortTermCheckOutTime: times.checkOutTime,
  } };
}
