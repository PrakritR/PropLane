import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl, resolveShareableAppOrigin } from "@/lib/app-url";
import type { HouseholdCharge } from "@/lib/household-charges";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { mintPhoneBoundLink, PhoneBoundLinkError } from "@/lib/one-number/links.server";
import { accountlessResidentPhoneKeys, isDeletedResidentEmail } from "@/lib/payments/accountless-resident-phone.server";
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

// ---------------------------------------------------------------------------------------------
// One resident's pay link, on demand (a reminder text the manager sends from the work number)
// ---------------------------------------------------------------------------------------------

const PAYABLE = new Set(["pending", "failed", "partially_paid"]);

export type ResidentRentPayLink =
  | {
      ok: true;
      url: string;
      /** Last four digits of the phone the link is bound to (the code is texted there). Never the whole number. */
      phoneLast4: string;
      expiresAt: string | null;
      /** True when the resident has no PropLane login: the phone came from their lease, and the link pays by card. */
      accountless: boolean;
      chargeIds: string[];
      residentName: string;
      firstName: string;
      /** The charge's own amount label (its balance when part-paid), for "your December rent of {amount}". */
      amountLabel: string;
    }
  | {
      ok: false;
      error:
        | "charge_not_found"
        | "not_payable"
        | "not_yours"
        | "mixed_charges"
        | "no_phone_on_file"
        | "links_unavailable"
        | "rate_limited";
    };

type ChargeRow = { id: string; status?: string | null; manager_user_id?: string | null; resident_user_id?: string | null; row_data?: HouseholdCharge | null };

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * Mint the phone-bound `/l/<token>` rent link for one resident's open charge(s), whether or not the resident has a
 * PropLane login. The link opens the in-page card payment for exactly these charges after a code is texted to the
 * phone it is bound to:
 *
 * - a resident with an account: the account's VERIFIED phone (unverified = `no_phone_on_file`);
 * - a resident with no login (an imported resident, `resident_user_id` null): the phone on the manager's lease /
 *   application record for that house and address (`accountlessResidentPhoneKeys`). With two numbers on file it is
 *   refused rather than guessed.
 *
 * Every charge must be open, under `ownerUserId` (when given), for one resident and one workspace. Earlier links keep
 * working (`supersede: false`, as reminder links do); a payment, the 10-day expiry or a changed phone ends them.
 */
export async function mintResidentRentPayLink(
  db: SupabaseClient,
  input: { chargeIds: readonly string[]; ownerUserId?: string | null; createdBy?: string | null; now?: Date; origin?: string },
): Promise<ResidentRentPayLink> {
  const ids = [...new Set(input.chargeIds.map((id) => str(id)).filter((id) => id && !id.includes(",")))];
  if (ids.length === 0 || ids.length > 10) return { ok: false, error: "charge_not_found" };

  const rows: ChargeRow[] = [];
  for (const id of ids) {
    const { data, error } = await db
      .from("portal_household_charge_records")
      .select("id, status, manager_user_id, resident_user_id, row_data")
      .eq("id", id)
      .maybeSingle();
    if (error || !data) return { ok: false, error: "charge_not_found" };
    rows.push(data as ChargeRow);
  }

  const managers = new Set(rows.map((r) => str(r.manager_user_id) || str(r.row_data?.managerUserId)));
  if (managers.size !== 1 || managers.has("")) return { ok: false, error: "mixed_charges" };
  const managerUserId = [...managers][0]!;
  if (input.ownerUserId && str(input.ownerUserId) !== managerUserId) return { ok: false, error: "not_yours" };
  if (rows.some((r) => !r.row_data?.id || !PAYABLE.has(str(r.status) || str(r.row_data?.status)))) {
    return { ok: false, error: "not_payable" };
  }
  const accounts = new Set(rows.map((r) => str(r.resident_user_id) || str(r.row_data?.residentUserId)));
  const emails = new Set(rows.map((r) => str(r.row_data?.residentEmail).toLowerCase()));
  const properties = new Set(rows.map((r) => str(r.row_data?.propertyId)));
  if (accounts.size !== 1 || emails.size !== 1 || emails.has("") || properties.size !== 1 || properties.has("")) {
    return { ok: false, error: "mixed_charges" };
  }
  const residentUserId = [...accounts][0]!;
  const residentEmail = [...emails][0]!;
  const propertyId = [...properties][0]!;
  const accountless = !residentUserId;

  let phoneKey = "";
  if (accountless) {
    if (isDeletedResidentEmail(residentEmail)) return { ok: false, error: "no_phone_on_file" };
    const keys = await accountlessResidentPhoneKeys(db, { managerUserId, propertyId, residentEmail });
    if (keys.length !== 1) return { ok: false, error: "no_phone_on_file" };
    phoneKey = keys[0]!;
  } else {
    const { data: profile } = await db.from("profiles").select("phone, phone_verified_at").eq("id", residentUserId).maybeSingle();
    const prof = (profile ?? null) as { phone?: string | null; phone_verified_at?: string | null } | null;
    const key = normalizeConsentPhone(str(prof?.phone));
    if (!str(prof?.phone_verified_at) || !/^\d{10}$/.test(key)) return { ok: false, error: "no_phone_on_file" };
    phoneKey = key;
  }

  const workspaceId = await resolveWorkspaceForProperty(db, propertyId, managerUserId);
  if (!workspaceId) return { ok: false, error: "links_unavailable" };
  try {
    const minted = await mintPhoneBoundLink(db, {
      phoneKey,
      workspaceId,
      purpose: "rent",
      targetType: "charge",
      targetId: [...ids].sort().join(","),
      createdBy: str(input.createdBy) || managerUserId,
      now: input.now,
      origin: input.origin ?? resolveEmailLinkBaseUrl(),
      supersede: false,
    });
    const first = rows[0]!.row_data!;
    const residentName = str(first.residentName);
    return {
      ok: true,
      url: minted.url,
      phoneLast4: phoneKey.slice(-4),
      expiresAt: minted.expiresAt,
      accountless,
      chargeIds: [...ids].sort(),
      residentName,
      firstName: firstNameOf(residentName),
      amountLabel: rows.length === 1 ? str(first.balanceLabel) || str(first.amountLabel) : "",
    };
  } catch (error) {
    if (error instanceof PhoneBoundLinkError && error.code === "rate_limited") return { ok: false, error: "rate_limited" };
    return { ok: false, error: "links_unavailable" };
  }
}
