/**
 * The short-stay half of the channel rule (see `@/lib/notice-channel`, which owns `noticeChannelFor`): the
 * portal copy of each outcome notice (requested, confirmed, approved, declined, expired, unpaid).
 */
import { residentPortalUrl } from "@/lib/claw-resident-links";
import { SHORT_STAY_HOLD_HOURS, SHORT_STAY_PAY_HOURS } from "@/lib/short-stay/guest-stays";
import { formatShortStayMoney, shortStayCompactRange } from "@/lib/short-stay-request";

export { noticeChannelFor, type NoticeChannel } from "@/lib/notice-channel";

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
        text: `Your request for ${where}, ${when}, is with the host. They have ${SHORT_STAY_HOLD_HOURS} hours to answer, and we will tell you here and by email. See it in your applications: ${staysUrl}`,
      };
    case "confirmed":
      return {
        subject: `Confirmed: ${where}`,
        text: `Confirmed: ${where}, ${when}. ${pay}\n\nCheck-in details are in your applications: ${staysUrl}`,
      };
    case "approved":
      return {
        subject: `Approved: ${where}`,
        text: `The host approved ${where}, ${when}. ${pay}\n\nSee it in your applications: ${staysUrl}`,
      };
    case "declined":
      return {
        subject: `Not confirmed: ${where}`,
        text: `The host could not confirm ${where}, ${plainRange(input)}. Other nights may be open: ${staysUrl}`,
      };
    case "expired":
      return {
        subject: `Request expired: ${where}`,
        text: `The host did not answer in time for ${where}, ${plainRange(input)}, so those nights are free again. You can request other nights from your applications: ${staysUrl}`,
      };
    default:
      return {
        subject: `Released, unpaid: ${where}`,
        text: `We did not get payment for ${where}, ${plainRange(input)}, within ${SHORT_STAY_PAY_HOURS} hours, so those nights are free again. You can request them again from your applications: ${staysUrl}`,
      };
  }
}
