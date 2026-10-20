import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl, resolveShareableAppOrigin } from "@/lib/app-url";
import type { HouseholdCharge } from "@/lib/household-charges";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { mintPhoneBoundLink } from "@/lib/one-number/links.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { residentChargesListHref } from "@/lib/portal-detail-routes";

export type RentPayLink =
  | { kind: "phone_bound"; url: string }
  /** No verified phone, or no link could be issued: the resident's own Payments page, behind sign-in. */
  | { kind: "portal"; url: string };

/** The resident's own Payments page (a text with no phone-bound link falls back to this). */
export function residentPaymentsPortalUrl(): string {
  return `${resolveShareableAppOrigin()}${residentChargesListHref("/resident", "pending")}`;
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());

/**
 * A fresh pay link for a rent reminder.
 *
 * With a verified phone it is a phone-bound `/l/<token>` rent link: tap, a code to the same phone, pay by
 * card, no app and no sign-in. It names exactly the charges the reminder is about, in the workspace that
 * holds the house, and is bound to the phone on the resident's account. Earlier links from earlier reminders
 * keep working (`supersede: false`): only a payment, the 10-day expiry or a changed phone ends one. It is
 * minted once per reminder occurrence, because the reminder channel claim is taken before this runs, so a
 * cron retry of a delivered reminder never mints another; the per-phone mint limit (20 an hour) caps the rest.
 *
 * Without a verified phone, a charge with no resident account, more charges than a link can carry, or any
 * refusal from the link service (rate limit, a test workspace) it is the portal Payments URL instead, so a
 * reminder always carries a way to pay.
 */
export async function mintRentReminderPayLink(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    charges: ReadonlyArray<Pick<HouseholdCharge, "id" | "propertyId" | "residentUserId">>;
    /** The resident's profile phone and when they verified it. */
    phone: string | null | undefined;
    phoneVerifiedAt: string | null | undefined;
    now?: Date;
  },
): Promise<RentPayLink> {
  const portal: RentPayLink = { kind: "portal", url: residentPaymentsPortalUrl() };
  const phoneKey = normalizeConsentPhone(str(input.phone));
  if (!input.phoneVerifiedAt || !/^\d{10}$/.test(phoneKey)) return portal;

  const charges = input.charges.filter((c) => str(c.id) && !str(c.id).includes(",")).slice(0, 10);
  if (charges.length === 0) return portal;
  // The link opens only for the resident named on the charge, so the charge must name one.
  const residents = new Set(charges.map((c) => str(c.residentUserId)));
  if (residents.size !== 1 || residents.has("")) return portal;

  try {
    // One link names one workspace: the house's own, else the owner's default.
    const workspaceId = await resolveWorkspaceForProperty(db, str(charges[0]!.propertyId) || null, input.ownerUserId);
    if (!workspaceId) return portal;
    for (const charge of charges) {
      const w = await resolveWorkspaceForProperty(db, str(charge.propertyId) || null, input.ownerUserId);
      if (w !== workspaceId) return portal;
    }
    const minted = await mintPhoneBoundLink(db, {
      phoneKey,
      workspaceId,
      purpose: "rent",
      targetType: "charge",
      targetId: charges.map((c) => str(c.id)).join(","),
      createdBy: input.ownerUserId,
      now: input.now,
      origin: resolveEmailLinkBaseUrl(),
      supersede: false,
    });
    return { kind: "phone_bound", url: minted.url };
  } catch {
    return portal;
  }
}
