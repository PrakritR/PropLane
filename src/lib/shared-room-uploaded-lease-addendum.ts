import type { LeaseGenerationContext } from "@/lib/generated-lease";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import { escapeHtml } from "@/lib/manager-application-html";
import { resolveStayPricing } from "@/lib/room-pricing";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { roomHoldsMultipleResidents } from "@/lib/shared-room-display";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";

function bedLabel(bed: string | undefined): string {
  const id = (bed ?? "A").trim() || "A";
  return id.length === 1 ? `Bed ${id.toUpperCase()}` : id;
}

/**
 * HTML block appended to uploaded (manager-template) leases for shared rooms —
 * bed, rent, and joint vs separate roommate terms (C2-SR12).
 */
export function buildSharedRoomUploadedLeaseAddendumHtml(ctx: LeaseGenerationContext): string | null {
  const sub = ctx.submission ? normalizeManagerListingSubmissionV1(ctx.submission) : undefined;
  const room = resolveSubmissionRoom(sub, {
    roomChoices: [ctx.application.roomChoice1],
    unitLabel: ctx.leasedRoom?.unitLabel,
  });
  if (!room || !roomHoldsMultipleResidents(room)) return null;

  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const pricing = resolveStayPricing({ room, submission: sub, application: ctx.application });
  const monthly = pricing.monthlyRate ?? room.monthlyRent ?? 0;
  const rentLabel = monthly > 0 ? `${formatRoomPriceAmount(monthly)} per month` : "As set on this lease";
  const prop = ctx.leasedRoom ?? ctx.listingProperty;
  const address = escapeHtml(prop?.address?.trim() || prop?.buildingName?.trim() || "the property");
  const roomName = escapeHtml(room.name?.trim() || "the room");
  const slot = ctx.application.residentSlot;
  const bed = bedLabel(slot != null && slot > 0 ? String.fromCharCode(64 + Math.min(slot, 26)) : undefined);
  const joint =
    room.sharedRoomLeaseKind === "joint"
      ? `<p><strong>Roommates on this lease.</strong> Roommates in this shared room sign one joint lease and are each responsible for the full rent.</p>`
      : `<p><strong>Separate lease.</strong> This lease covers ${bed} only. Each other resident of the room signs and pays under their own lease.</p>`;

  return `<section class="shared-room-addendum" data-attr="shared-room-lease-addendum">
<h2>Shared room addendum</h2>
<p><strong>Your space.</strong> Resident has the right to use ${bed} in ${roomName} at ${address} (a shared room with up to ${capacity} residents), together with the shared areas of the home.</p>
<p><strong>Rent.</strong> Rent for ${bed} is ${escapeHtml(rentLabel)}.</p>
${joint}
<p><strong>Shared spaces and roommates.</strong> Residents of the room keep shared areas clean, follow house rules on quiet hours, and give other residents notice of overnight guests.</p>
</section>`;
}

export function appendSharedRoomAddendumToLeaseHtml(ctx: LeaseGenerationContext, html: string): string {
  const addendum = buildSharedRoomUploadedLeaseAddendumHtml(ctx);
  if (!addendum?.trim()) return html;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${addendum}</body>`);
  return `${html}${addendum}`;
}
