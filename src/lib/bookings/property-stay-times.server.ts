import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePropertyStayTimes, type PropertyStayTimes } from "@/lib/bookings/stay-times";
import { DEFAULT_PROPERTY_TIME_ZONE, propertyTimeZoneForZip } from "@/lib/property-time-zone";

export type PropertyStayClock = { times: PropertyStayTimes; timeZone: string };

/** The property-record fields a stay's clock is read from, for a caller that already loaded the row. */
export function propertyStayClockFromRecord(record: { row_data?: unknown; property_data?: unknown } | null): PropertyStayClock {
  const rowData = (record?.row_data ?? {}) as { zip?: unknown; submission?: { zip?: unknown; stayTimes?: unknown } };
  const propertyData = (record?.property_data ?? {}) as { listingSubmission?: { zip?: unknown; stayTimes?: unknown } };
  const zip =
    String(rowData.zip ?? "").trim() ||
    String(rowData.submission?.zip ?? "").trim() ||
    String(propertyData.listingSubmission?.zip ?? "").trim();
  return {
    times: normalizePropertyStayTimes(propertyData.listingSubmission?.stayTimes ?? rowData.submission?.stayTimes),
    timeZone: propertyTimeZoneForZip(zip),
  };
}

/**
 * A property's default stay times (`listingSubmission.stayTimes`) and its
 * time zone (from its ZIP). Defaults and Pacific when the row is missing or
 * the read fails — a stay always has a clock.
 */
export async function loadPropertyStayClock(db: SupabaseClient, propertyId: string | null): Promise<PropertyStayClock> {
  if (!propertyId) return { times: normalizePropertyStayTimes(null), timeZone: DEFAULT_PROPERTY_TIME_ZONE };
  try {
    const { data } = await db
      .from("manager_property_records")
      .select("row_data, property_data")
      .eq("id", propertyId)
      .maybeSingle();
    return propertyStayClockFromRecord(data);
  } catch {
    return { times: normalizePropertyStayTimes(null), timeZone: DEFAULT_PROPERTY_TIME_ZONE };
  }
}
