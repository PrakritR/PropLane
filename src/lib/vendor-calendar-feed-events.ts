import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { IcsTimedEvent } from "@/lib/ical/serialize";
import { vendorCanSeeFullWorkOrderSite, workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";

/** Same canonical visit length the vendor Calendar and the Google push use. */
export const VENDOR_FEED_VISIT_MINUTES = 60;

function fullAddress(row: DemoManagerWorkOrderRow): string {
  const address = row.propertyAddress?.trim();
  if (address) return address;
  const unit = row.unit?.trim();
  const name = row.propertyName?.trim() ?? "";
  return unit && unit !== "—" && name ? `${name} · ${unit}` : name;
}

/**
 * One feed event per scheduled, not-finished service assigned to the vendor. The street address
 * goes out only once the vendor is actually hired for the site (`vendorCanSeeFullWorkOrderSite`);
 * anything else gets the general area, exactly like the portal. A job with no scheduled time is
 * not an event.
 */
export function vendorJobToFeedEvent(id: string, row: DemoManagerWorkOrderRow): IcsTimedEvent | null {
  if (!row.scheduledAtIso) return null;
  const bucket = typeof row.bucket === "string" ? row.bucket.toLowerCase() : "";
  if (bucket === "completed" || bucket === "cancelled") return null;
  const start = new Date(row.scheduledAtIso);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + VENDOR_FEED_VISIT_MINUTES * 60_000);
  const hired = vendorCanSeeFullWorkOrderSite(row);
  return {
    uid: `${id}@proplane.ai`,
    summary: row.title?.trim() || "Service visit",
    start,
    end,
    location: hired ? fullAddress(row) : workOrderGeneralArea(row),
    description: hired ? row.description : null,
  };
}

export function vendorJobsToFeedEvents(
  records: ReadonlyArray<{ id: string; row_data: unknown }>,
): IcsTimedEvent[] {
  const events: IcsTimedEvent[] = [];
  for (const record of records) {
    if (!record.row_data || typeof record.row_data !== "object") continue;
    const event = vendorJobToFeedEvent(record.id, record.row_data as DemoManagerWorkOrderRow);
    if (event) events.push(event);
  }
  return events;
}
