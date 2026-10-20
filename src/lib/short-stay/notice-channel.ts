/**
 * Web vs Messages (captain, Oct 20): a request made in the resident portal is answered in the portal and
 * by email, never by text; a request made by text is answered by text. ONE helper decides, from what the
 * row says about where it was made, and every outcome notice (requested, confirmed, approved, declined,
 * expired, unpaid) asks it:
 *
 *   portal -> email + the resident portal inbox, with /resident links; never SMS, never a /l/ pay link
 *   sms    -> today's behaviour, unchanged (the work-number text, the phone-bound pay link)
 *
 * Anything this cannot read is `sms`: that is what every row did before the channel was recorded, so an
 * older row keeps its old behaviour.
 */
import { residentPortalUrl } from "@/lib/claw-resident-links";
import {
  GUEST_PORTAL_SHORT_STAY_SOURCE,
  SHORT_STAY_HOLD_HOURS,
  SHORT_STAY_PAY_HOURS,
} from "@/lib/short-stay/guest-stays";
import { formatShortStayMoney, shortStayCompactRange } from "@/lib/short-stay-request";

export type NoticeChannel = "portal" | "sms";

const PORTAL_SOURCES = new Set([GUEST_PORTAL_SHORT_STAY_SOURCE, "portal", "resident_portal", "web", "app"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Where a request was made, from the stored row: a stay's `row_data` (`stayDetails.source`), or an
 * application / tour record carrying `noticeChannel`, `channel`, `source_channel` or `source`.
 */
export function noticeChannelFor(row: unknown): NoticeChannel {
  const record = asRecord(row);
  const details = asRecord(record.stayDetails);
  for (const candidate of [record.noticeChannel, record.channel, details.source, record.sourceChannel, record.source_channel, record.source]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const value = candidate.trim().toLowerCase();
    if (value === "sms" || value === "text") return "sms";
    if (value === "portal" || PORTAL_SOURCES.has(value)) return "portal";
    // A known text-origin source (sms_short_stay, the legacy public card) or anything unreadable.
    return "sms";
  }
  return "sms";
}

export type PortalNoticeKind = "requested" | "confirmed" | "approved" | "declined" | "expired" | "unpaid_released";

export type PortalNoticeInput = {
  roomLabel: string;
  propertyLabel: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  total: number | null;
};

export type PortalNotice = { subject: string; text: string };

function plainRange(input: Pick<PortalNoticeInput, "checkIn" | "checkOut">): string {
  return shortStayCompactRange(input.checkIn, input.checkOut).replace(/\s*–\s*/, " to ");
}

function nightsMoney(input: PortalNoticeInput): string {
  const nights = `${input.nights} ${input.nights === 1 ? "night" : "nights"}`;
  return input.total != null ? `${nights}, ${formatShortStayMoney(input.total)}` : nights;
}

/**
 * The email + portal-inbox notice for a stay made in the portal. Every link is a /resident address (Stays,
 * Payments, the request page); there is no pay link to a texted page, no phone number and no sms: link.
 * No long dashes.
 */
export function guestStayPortalNotice(kind: PortalNoticeKind, input: PortalNoticeInput): PortalNotice {
  const staysUrl = residentPortalUrl("stays");
  const paymentsUrl = residentPortalUrl("payments");
  const where = `${input.roomLabel} at ${input.propertyLabel}`;
  const when = `${plainRange(input)} (${nightsMoney(input)})`;
  const pay = `${input.total != null ? `Pay ${formatShortStayMoney(input.total)}` : "Pay"} in Payments within ${SHORT_STAY_PAY_HOURS} hours to keep it: ${paymentsUrl}`;
  switch (kind) {
    case "requested":
      return {
        subject: `Request sent: ${where}`,
        text: `Your request for ${where}, ${when}, is with the host. They have ${SHORT_STAY_HOLD_HOURS} hours to answer, and we will tell you here and by email. See it in Stays: ${staysUrl}`,
      };
    case "confirmed":
      return {
        subject: `Confirmed: ${where}`,
        text: `Confirmed: ${where}, ${when}. ${pay}\n\nCheck-in details are in Stays: ${staysUrl}`,
      };
    case "approved":
      return {
        subject: `Approved: ${where}`,
        text: `The host approved ${where}, ${when}. ${pay}\n\nSee it in Stays: ${staysUrl}`,
      };
    case "declined":
      return {
        subject: `Not confirmed: ${where}`,
        text: `The host could not confirm ${where}, ${plainRange(input)}. Other nights may be open: ${staysUrl}`,
      };
    case "expired":
      return {
        subject: `Request expired: ${where}`,
        text: `The host did not answer in time for ${where}, ${plainRange(input)}, so those nights are free again. You can request other nights from Stays: ${staysUrl}`,
      };
    default:
      return {
        subject: `Released, unpaid: ${where}`,
        text: `We did not get payment for ${where}, ${plainRange(input)}, within ${SHORT_STAY_PAY_HOURS} hours, so those nights are free again. You can request them again from Stays: ${staysUrl}`,
      };
  }
}
