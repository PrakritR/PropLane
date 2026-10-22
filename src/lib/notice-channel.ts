/**
 * Web vs Messages (captain, Oct 20): a request made in the portal / website / app is answered in the
 * resident portal and by email, never by text; a request made by text is answered by text. The channel is
 * RECORDED on the row when it is made, and every outcome notice asks ONE helper, `noticeChannelFor(row)`:
 *
 *   portal -> email + the resident portal inbox, with /resident links; never SMS, never a /l/ pay link
 *   sms    -> today's behaviour, unchanged (work-number text, phone-bound pay link)
 *
 * Anything this cannot read is `sms`: that is what every row did before the channel was recorded, so an
 * older row keeps its old behaviour. Pure and client-safe.
 *
 * The recorded fields: `noticeChannel` on an application or tour row (server-owned: set where the row is
 * created, never taken from a request body), `stayDetails.source` on a short stay, and
 * `payload.__noticeChannel` on an action event so a retry of a delivery keeps the channel it was sent on.
 * The lead-source column `source_channel` ("zillow", "facebook"...) is a different fact and is never read.
 */
import { residentPortalUrl, type ResidentSmsLinkKind } from "@/lib/claw-resident-links";

export type NoticeChannel = "portal" | "sms";

/** Written on `stayDetails.source` by `POST /api/resident/stays` (the resident portal's stay application). */
const PORTAL_SOURCES = new Set(["guest_portal", "portal", "resident_portal", "web", "app"]);

/** Key on an action event's stored payload: the channel its resident copy must be delivered on. */
export const NOTICE_CHANNEL_PAYLOAD_KEY = "__noticeChannel";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Where a request was made, from the stored row (a stay, an application, a tour inquiry).
 *
 * A STAY is read from `stayDetails.source` alone: that is the field the stay core owns, while a booking
 * row's top-level `channel` is the listing channel it came from ("airbnb") and its top-level
 * `noticeChannel` is not written by anything (a manager's save cannot smuggle one in - see
 * `carryGuestStayFields`).
 */
export function noticeChannelFor(row: unknown): NoticeChannel {
  const record = asRecord(row);
  const details = asRecord(record.stayDetails);
  const candidates = record.stayDetails !== undefined ? [details.source] : [record.noticeChannel, record.channel];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const value = candidate.trim().toLowerCase();
    if (value === "sms" || value === "text") return "sms";
    if (value === "portal" || PORTAL_SOURCES.has(value)) return "portal";
    // A known text-origin source (sms_short_stay, the legacy public card) or anything unreadable.
    return "sms";
  }
  return "sms";
}

/** The channel an action event's payload was stamped with; `sms` (today's behaviour) when absent. */
export function payloadNoticeChannel(payload: unknown): NoticeChannel {
  return asRecord(payload)[NOTICE_CHANNEL_PAYLOAD_KEY] === "portal" ? "portal" : "sms";
}

/** Which resident portal section an event's domain lives in. */
const PORTAL_KIND_FOR_DOMAIN: Record<string, ResidentSmsLinkKind> = {
  application: "applications",
  payment: "payments",
  lease: "lease",
  tour: "tour",
  service_request: "services",
  work_order: "services_work_orders",
  channel_booking: "stays",
};

/**
 * Adds the resident portal address for `domain` under the text, unless it already carries a /resident link.
 * The only link a portal-channel notice may carry: no /l/ pay link, no sms: link, no phone number.
 */
export function withResidentPortalLink(text: string, domain: string | undefined): string {
  if (/\/resident\//.test(text)) return text;
  const kind = domain ? PORTAL_KIND_FOR_DOMAIN[domain] : undefined;
  return `${text.trimEnd()}\n\nSee it in your portal: ${residentPortalUrl(kind ?? "inbox")}`;
}

/**
 * The row to store: its `noticeChannel` is server-owned. The STORED row's channel wins (a later write by a
 * manager, or by the applicant from another device, never moves it), else the writer's (`portal` for an
 * applicant's own web write, null for a manager writing a row for someone, which records nothing), and a value
 * in the request body never counts.
 */
export function withRecordedNoticeChannel<T extends object>(row: T, stored: unknown, writer: NoticeChannel | null): T {
  const { noticeChannel: _fromBody, ...rest } = row as T & { noticeChannel?: unknown };
  void _fromBody;
  const kept = asRecord(stored).noticeChannel;
  const channel: NoticeChannel | null = kept === "portal" || kept === "sms" ? kept : writer;
  return (channel ? { ...rest, noticeChannel: channel } : rest) as T;
}
