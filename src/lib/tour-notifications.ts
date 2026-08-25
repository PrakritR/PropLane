/**
 * Scheduled tour notification copy — shared by portal UI previews and server delivery.
 */

import { formatPacificDateTime } from "@/lib/pacific-time";
import { buildRentalApplyHref } from "@/lib/rental-application/apply-from-listing";

export const TOUR_REQUEST_MANAGER_SUBJECT = "New tour request — PropLane";

export const TOUR_REQUEST_TENANT_SUBJECT = "We received your tour request — PropLane";

export const TOUR_CONFIRMED_TENANT_SUBJECT = "Your PropLane tour is confirmed";

export const TOUR_CANCELED_TENANT_SUBJECT = "Your PropLane tour was cancelled";

export const TOUR_REQUEST_REMOVED_TENANT_SUBJECT = "Your PropLane tour request was removed";

export const TOUR_RESCHEDULED_TENANT_SUBJECT = "Your PropLane tour has a new time";

export type TourNotificationContext = {
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
  propertyTitle: string;
  propertyAddress?: string;
  roomLabel?: string;
  tourStartIso: string;
  tourEndIso: string;
  notes?: string;
  managerLabel?: string;
  instructions?: string;
  applyUrl: string;
  /** Resident sign-up — track tours and message the property team in PropLane. */
  createAccountUrl?: string;
  residentPortalUrl?: string;
};

export function formatTourTimeRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Scheduled time";
  const startLabel = formatPacificDateTime(start);
  const endLabel = formatPacificDateTime(end).replace(/^\w{3} \d{1,2}, /, "");
  return `${startLabel} – ${endLabel}`;
}

export function buildTourApplyUrl(origin: string, propertyId?: string | null, roomLabel?: string | null): string {
  const base = origin.replace(/\/$/, "");
  if (!propertyId?.trim()) return `${base}/rent/apply`;
  const path = buildRentalApplyHref({
    propertyId: propertyId.trim(),
    listingRoomName: roomLabel?.trim() || undefined,
  });
  return `${base}${path}`;
}

export function buildTourRequestManagerBody(ctx: TourNotificationContext): string {
  const when = formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso);
  const lines = [
    "Hi,",
    "",
    "Someone requested a property tour through PropLane.",
    "",
    `Guest: ${ctx.guestName || "Guest"}${ctx.guestEmail ? ` (${ctx.guestEmail})` : ""}`,
  ];
  if (ctx.guestPhone?.trim()) lines.push(`Phone: ${ctx.guestPhone.trim()}`);
  lines.push(
    `Property: ${ctx.propertyTitle || "Property"}`,
  );
  if (ctx.roomLabel?.trim()) lines.push(`Room: ${ctx.roomLabel.trim()}`);
  if (ctx.propertyAddress?.trim()) lines.push(`Address: ${ctx.propertyAddress.trim()}`);
  lines.push(`Requested time: ${when}`);
  if (ctx.notes?.trim()) {
    lines.push("", "Notes from guest:", ctx.notes.trim());
  }
  lines.push(
    "",
    "Open your PropLane manager portal calendar to approve or decline this tour request.",
    "",
    "— PropLane",
  );
  return lines.join("\n");
}

export function buildTourRequestTenantBody(ctx: TourNotificationContext): string {
  const greeting = ctx.guestName.trim() ? `Hi ${ctx.guestName.trim()},` : "Hi,";
  const when = formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso);
  const lines = [
    greeting,
    "",
    "We received your tour request and sent it to the property manager for review.",
    "",
    `Requested time: ${when}`,
    `Property: ${ctx.propertyTitle || "Property"}`,
  ];
  if (ctx.roomLabel?.trim()) lines.push(`Room: ${ctx.roomLabel.trim()}`);
  if (ctx.propertyAddress?.trim()) lines.push(`Address: ${ctx.propertyAddress.trim()}`);
  lines.push(
    "",
    "This tour is NOT confirmed yet.",
    // Said plainly and before anything else, because a requested time reads like a booked one.
    // A guest who travels to a property on an unconfirmed request finds nobody there, and the
    // manager only hears about it as a complaint.
    "Please do not go to the property until you receive a confirmation email from us. The manager still has to approve this time, and they may offer a different one.",
    "",
    "You will receive a separate confirmation email once the manager approves your tour time.",
  );
  if (ctx.createAccountUrl?.trim()) {
    lines.push(
      "",
      "Track this tour in PropLane",
      "Create a free resident account to see tour updates, message your property team, and apply when you are ready:",
      ctx.createAccountUrl.trim(),
    );
  }
  lines.push("", "— PropLane");
  return lines.join("\n");
}

export function buildTourConfirmedTenantBody(ctx: TourNotificationContext): string {
  const greeting = ctx.guestName.trim() ? `Hi ${ctx.guestName.trim()},` : "Hi,";
  const when = formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso);
  const lines = [
    greeting,
    "",
    "Your property tour is confirmed.",
    "",
    `When: ${when}`,
    `Property: ${ctx.propertyTitle || "Property"}`,
  ];
  if (ctx.roomLabel?.trim()) lines.push(`Room: ${ctx.roomLabel.trim()}`);
  if (ctx.propertyAddress?.trim()) lines.push(`Address: ${ctx.propertyAddress.trim()}`);
  if (ctx.managerLabel?.trim()) lines.push(`Host: ${ctx.managerLabel.trim()}`);
  if (ctx.instructions?.trim()) {
    lines.push("", "Before you arrive:", ctx.instructions.trim());
  }
  lines.push(
    "",
    "Next step — apply for this home",
    "If you are interested after your tour, submit your rental application using the link below:",
    ctx.applyUrl,
    "",
    "What to expect in the application:",
    "• Basic contact and household information",
    "• Employment and income details",
    "• Application fee payment (when required for this listing)",
    "",
    "Questions before or after your tour? Reply in your PropLane inbox and your property team will help.",
  );
  if (ctx.createAccountUrl?.trim()) {
    lines.push(
      "",
      "Create a free resident account to track this tour, read manager messages, and apply when you are ready:",
      ctx.createAccountUrl.trim(),
    );
  } else if (ctx.residentPortalUrl?.trim()) {
    lines.push("", "Sign in to your PropLane resident portal to view messages:", ctx.residentPortalUrl.trim());
  }
  lines.push("", "— PropLane");
  return lines.join("\n");
}

/**
 * A confirmed tour that changes has to reach the guest.
 *
 * PropLane has already emailed them "Your PropLane tour is confirmed", so from
 * that point the guest is holding a commitment. Cancelling or moving one used
 * to be silent — the tour vanished from the manager's calendar and the guest
 * still showed up. These two are the guest-facing half of those actions.
 */
export function buildTourCanceledTenantBody(
  ctx: TourNotificationContext,
  reason?: string | null,
): string {
  const greeting = ctx.guestName.trim() ? `Hi ${ctx.guestName.trim()},` : "Hi,";
  const lines = [
    greeting,
    "",
    "Your property tour has been cancelled by the property team.",
    "",
    `Was scheduled for: ${formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso)}`,
    `Property: ${ctx.propertyTitle || "Property"}`,
  ];
  if (ctx.roomLabel?.trim()) lines.push(`Room: ${ctx.roomLabel.trim()}`);
  if (ctx.propertyAddress?.trim()) lines.push(`Address: ${ctx.propertyAddress.trim()}`);
  if (reason?.trim()) lines.push("", "Reason:", reason.trim());
  lines.push(
    "",
    "Please do not travel to the property at that time.",
    "",
    "You are welcome to book another tour whenever it suits you:",
    ctx.applyUrl,
    "",
    "Questions? Reply in your PropLane inbox and your property team will help.",
    "",
    "— PropLane",
  );
  return lines.join("\n");
}

/** Pending tour request removed by the manager before it was confirmed. */
export function buildTourRequestRemovedTenantBody(ctx: TourNotificationContext): string {
  const greeting = ctx.guestName.trim() ? `Hi ${ctx.guestName.trim()},` : "Hi,";
  const when = formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso);
  const lines = [
    greeting,
    "",
    "The property manager removed your tour request.",
    "",
    `Requested time: ${when}`,
    `Property: ${ctx.propertyTitle || "Property"}`,
  ];
  if (ctx.roomLabel?.trim()) lines.push(`Room: ${ctx.roomLabel.trim()}`);
  if (ctx.propertyAddress?.trim()) lines.push(`Address: ${ctx.propertyAddress.trim()}`);
  lines.push(
    "",
    "This tour is no longer scheduled. You are welcome to request another time on the listing page.",
    "",
    "Questions? Reply in your PropLane inbox and your property team will help.",
    "",
    "— PropLane",
  );
  return lines.join("\n");
}

export function buildTourRescheduledTenantBody(
  ctx: TourNotificationContext,
  previous: { startIso: string; endIso: string },
  reason?: string | null,
): string {
  const greeting = ctx.guestName.trim() ? `Hi ${ctx.guestName.trim()},` : "Hi,";
  const lines = [
    greeting,
    "",
    "Your property tour has been moved to a new time.",
    "",
    `New time: ${formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso)}`,
    `Previous time: ${formatTourTimeRange(previous.startIso, previous.endIso)}`,
    `Property: ${ctx.propertyTitle || "Property"}`,
  ];
  if (ctx.roomLabel?.trim()) lines.push(`Room: ${ctx.roomLabel.trim()}`);
  if (ctx.propertyAddress?.trim()) lines.push(`Address: ${ctx.propertyAddress.trim()}`);
  if (ctx.managerLabel?.trim()) lines.push(`Host: ${ctx.managerLabel.trim()}`);
  if (reason?.trim()) lines.push("", "Note from the property team:", reason.trim());
  if (ctx.instructions?.trim()) lines.push("", "Before you arrive:", ctx.instructions.trim());
  lines.push(
    "",
    "If the new time does not work, reply in your PropLane inbox and the property team will find another.",
    "",
    "— PropLane",
  );
  return lines.join("\n");
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildTourConfirmedTenantHtml(ctx: TourNotificationContext): string {
  const greeting = ctx.guestName.trim()
    ? `Hi ${escapeHtmlText(ctx.guestName.trim())},`
    : "Hi,";
  const when = escapeHtmlText(formatTourTimeRange(ctx.tourStartIso, ctx.tourEndIso));
  const property = escapeHtmlText(ctx.propertyTitle || "Property");
  const address = ctx.propertyAddress?.trim()
    ? `<p style="margin:0 0 8px 0"><strong>Address:</strong> ${escapeHtmlText(ctx.propertyAddress.trim())}</p>`
    : "";
  const room = ctx.roomLabel?.trim()
    ? `<p style="margin:0 0 8px 0"><strong>Room:</strong> ${escapeHtmlText(ctx.roomLabel.trim())}</p>`
    : "";
  const host = ctx.managerLabel?.trim()
    ? `<p style="margin:0 0 8px 0"><strong>Host:</strong> ${escapeHtmlText(ctx.managerLabel.trim())}</p>`
    : "";
  const instructions = ctx.instructions?.trim()
    ? `<p style="margin:12px 0 8px 0"><strong>Before you arrive:</strong><br/>${escapeHtmlText(ctx.instructions.trim()).replace(/\n/g, "<br/>")}</p>`
    : "";
  const href = escapeHtmlAttr(ctx.applyUrl);
  const urlPlain = escapeHtmlText(ctx.applyUrl);
  const accountBlock = ctx.createAccountUrl?.trim()
    ? `<p style="margin:16px 0 8px 0"><strong>Track this tour in PropLane</strong></p>
<p style="margin:0 0 12px 0">Create a free resident account to see tour updates, message your property team, and apply when you are ready.</p>
<p style="margin:0 0 16px 0"><a href="${escapeHtmlAttr(ctx.createAccountUrl.trim())}" style="color:#2563eb;font-weight:600">${escapeHtmlText(ctx.createAccountUrl.trim())}</a></p>`
    : "";
  const cta = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0 8px 0">
<tr>
<td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;line-height:1.2">Apply for this home</a>
</td>
</tr>
</table>
<p style="margin:0 0 16px 0;font-size:13px;color:#64748b">If the button does not work, copy this link into your browser:<br/><span style="word-break:break-all;color:#334155">${urlPlain}</span></p>`;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 28px 32px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 12px 0">Your property tour is confirmed.</p>
<p style="margin:0 0 8px 0"><strong>When:</strong> ${when}</p>
<p style="margin:0 0 8px 0"><strong>Property:</strong> ${property}</p>
${room}${address}${host}${instructions}
<p style="margin:16px 0 8px 0"><strong>Next step — apply for this home</strong></p>
<p style="margin:0 0 12px 0">If you are interested after your tour, submit your rental application using the link below.</p>
${cta}
${accountBlock}
<p style="margin:0;font-size:13px;color:#64748b">Questions? Reply in your PropLane inbox and your property team will help.</p>
</div>
</body>
</html>`;
}

export function buildTourNotificationContext(input: {
  origin: string;
  guestName: string;
  guestEmail: string;
  guestPhone?: string | null;
  propertyId?: string | null;
  propertyTitle?: string | null;
  propertyAddress?: string | null;
  roomLabel?: string | null;
  tourStartIso: string;
  tourEndIso: string;
  notes?: string | null;
  managerLabel?: string | null;
  instructions?: string | null;
  tourInquiryId?: string | null;
}): TourNotificationContext {
  const origin = input.origin.replace(/\/$/, "");
  const nextPath = input.propertyId?.trim()
    ? `/rent/tours-contact?propertyId=${encodeURIComponent(input.propertyId.trim())}`
    : "/resident/applications";
  const createAccountParams = new URLSearchParams({ role: "resident", next: nextPath });
  const email = input.guestEmail?.trim().toLowerCase();
  if (email) createAccountParams.set("email", email);
  const guestPhone = input.guestPhone?.trim();
  if (guestPhone) createAccountParams.set("phone", guestPhone);
  const tourInquiryId = input.tourInquiryId?.trim();
  if (tourInquiryId) createAccountParams.set("tour_inquiry", tourInquiryId);
  return {
    guestName: input.guestName.trim(),
    guestEmail: input.guestEmail.trim(),
    guestPhone: guestPhone || undefined,
    propertyTitle: input.propertyTitle?.trim() || "Property",
    propertyAddress: input.propertyAddress?.trim() || undefined,
    roomLabel: input.roomLabel?.trim() || undefined,
    tourStartIso: input.tourStartIso,
    tourEndIso: input.tourEndIso,
    notes: input.notes?.trim() || undefined,
    managerLabel: input.managerLabel?.trim() || undefined,
    instructions: input.instructions?.trim() || undefined,
    applyUrl: buildTourApplyUrl(input.origin, input.propertyId, input.roomLabel),
    createAccountUrl: `${origin}/auth/create-account?${createAccountParams.toString()}`,
    residentPortalUrl: `${origin}/resident/applications`,
  };
}
