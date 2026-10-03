import type { LeaseGenerationContext } from "@/lib/generated-lease";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import { sharedRoomClausesHtml, sharedRoomLeaseTerms, withSharedRoomClauses, type SharedRoomLeaseTerms } from "@/lib/lease-shared-room-terms";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { parseMoneyAmount } from "@/lib/parse-money";

/**
 * Shared-room terms for a lease built on a manager's own document (an uploaded PDF or template),
 * where the document's bytes are never edited: the SAME clauses a generated lease prints
 * (`lease-shared-room-terms.ts`), headed "Shared room addendum". `ctx.sharedRoom` carries the
 * roommates the lease storage resolved; without it the addendum is built for this resident alone.
 */
function termsFor(ctx: LeaseGenerationContext): SharedRoomLeaseTerms | null {
  if (ctx.sharedRoom) return ctx.sharedRoom;
  const sub = ctx.submission ? normalizeManagerListingSubmissionV1(ctx.submission) : undefined;
  const room = resolveSubmissionRoom(sub, {
    roomChoices: [ctx.application.roomChoice1],
    unitLabel: ctx.leasedRoom?.unitLabel,
  });
  const prop = ctx.leasedRoom ?? ctx.listingProperty;
  const slot = Number(ctx.application.residentSlot);
  const rent = parseMoneyAmount(ctx.application.managerRentOverride ?? "");
  return sharedRoomLeaseTerms({
    room,
    propertyAddress: prop?.address?.trim() || prop?.buildingName?.trim() || sub?.address || "",
    term: ctx.application.leaseTerm,
    residents: [
      {
        name: ctx.application.fullLegalName ?? "",
        slot: Number.isInteger(slot) && slot >= 1 ? slot : null,
        rentOverride: rent > 0 ? rent : null,
      },
    ],
  });
}

/** HTML block appended to uploaded (manager-template) leases for shared rooms (C2-SR12). */
export function buildSharedRoomUploadedLeaseAddendumHtml(ctx: LeaseGenerationContext): string | null {
  const terms = termsFor(ctx);
  return terms ? sharedRoomClausesHtml(terms, { heading: "Shared room addendum" }) : null;
}

export function appendSharedRoomAddendumToLeaseHtml(ctx: LeaseGenerationContext, html: string): string {
  return withSharedRoomClauses(html, termsFor(ctx), { heading: "Shared room addendum" });
}
