import "server-only";

/**
 * Sends the automated GUEST messages: the tour confirmation for a visitor with no account, and the
 * hold-placed confirmation. Both ride transports that already log what they send (the tour path writes
 * the resend email + `sms_outbox` row + inbox record; the hold goes through the action-event bus, which
 * records one `action_events` row and one consumer per recipient).
 *
 * WIRING (owned by the callers, not here):
 *  - the guest tour booking route calls `notifyGuestTourConfirmed(db, inquiry, window)` after the tour is
 *    confirmed, in place of calling `notifyTenantTourConfirmed` directly;
 *  - the hold writer (charges/holds) calls `emitHoldPlaced(db, {...})` once the $100 hold is captured.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { managerSender } from "@/lib/domain-action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  HOLD_PLACED_EVENT,
  buildGuestTourConfirmedEmail,
  buildGuestTourConfirmedSms,
  renderHoldPlaced,
  type HoldPlacedFacts,
} from "@/lib/guest-notices";
import {
  notifyTenantTourConfirmed,
  resolvePropertyAddressForTour,
  type TourInquiryPayload,
  type TourNotificationResult,
} from "@/lib/tour-notification-delivery.server";

type Db = Parameters<typeof notifyTenantTourConfirmed>[0];

function formatLine(e164: string | null | undefined): string | null {
  const digits = String(e164 ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return null;
}

async function propLaneLine(): Promise<string | null> {
  try {
    const { getPublicTextingConfig } = await import("@/lib/marketing/public-texting.server");
    return formatLine((await getPublicTextingConfig()).phone);
  } catch {
    return null;
  }
}

/**
 * Tour confirmation for a visitor who has no account: email (when an address is given) and SMS (when a phone
 * with consent is given), plain time + address + how to reschedule. No /resident link anywhere.
 */
export async function notifyGuestTourConfirmed(
  db: Db,
  inquiry: TourInquiryPayload,
  window: { start: string; end: string; managerUserId: string; adminLabel?: string },
  instructions?: string,
): Promise<TourNotificationResult> {
  const record = inquiry as Record<string, unknown>;
  const propertyId = typeof record.propertyId === "string" ? record.propertyId.trim() : "";
  const origin = resolveEmailLinkBaseUrl();
  const facts = {
    guestName: typeof record.name === "string" ? record.name : null,
    propertyTitle: (typeof record.propertyTitle === "string" && record.propertyTitle.trim()) || "the home",
    propertyAddress: await resolvePropertyAddressForTour(db, propertyId),
    roomLabel: typeof record.roomLabel === "string" ? record.roomLabel : null,
    startIso: window.start,
    endIso: window.end,
    instructions: instructions ?? null,
    propLaneLine: await propLaneLine(),
    listingUrl: propertyId ? `${origin}/rent/listings/${propertyId}` : origin,
  };
  const email = buildGuestTourConfirmedEmail(facts);
  return notifyTenantTourConfirmed(db, null, inquiry, window, instructions, {
    subject: email.subject,
    body: email.text,
    smsText: buildGuestTourConfirmedSms(facts),
  });
}

/**
 * "$100 hold placed for <room>, expires <date>; credited to your deposit if you sign by then", to the holder
 * (email + text per their settings and consent) and a short manager notice. Idempotent on `holdId`.
 */
export async function emitHoldPlaced(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    holdId: string;
    holderEmail: string;
    holderUserId?: string;
    propertyId?: string;
    facts: HoldPlacedFacts;
  },
): Promise<void> {
  const sender = await managerSender(db, input.managerUserId);
  if (!sender.email) return;
  const resident = renderHoldPlaced(input.facts);
  await emitActionEvent(db, {
    eventId: `hold:${input.holdId}:${HOLD_PLACED_EVENT}`,
    domain: "payment",
    event: HOLD_PLACED_EVENT,
    managerUserId: input.managerUserId,
    entityId: input.holdId,
    category: "payments",
    senderUserId: sender.userId,
    senderEmail: sender.email,
    senderName: sender.name,
    payload: { propertyId: input.propertyId, amountLabel: input.facts.amountLabel, roomLabel: input.facts.roomLabel, expiresLabel: input.facts.expiresLabel },
    templateContext: { amountLabel: input.facts.amountLabel, roomLabel: input.facts.roomLabel, expiresLabel: input.facts.expiresLabel },
    recipients: [
      { audience: "resident", userId: input.holderUserId, email: input.holderEmail.trim().toLowerCase() || undefined, rendered: resident },
      {
        audience: "manager",
        userId: input.managerUserId,
        rendered: {
          subject: `Hold placed · ${input.facts.roomLabel}`,
          text: `A ${input.facts.amountLabel} hold was placed for ${input.facts.roomLabel}. It expires ${input.facts.expiresLabel}.`,
        },
      },
    ],
  });
}
