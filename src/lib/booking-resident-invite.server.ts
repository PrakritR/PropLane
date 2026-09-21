/**
 * The invite a booking-created resident gets: a link that creates their
 * account and lands them on move-in details, with application + lease
 * skipped entirely (docs/agents/resident-my-home.md; AGENTS.md "Resident
 * stage unlocks").
 *
 * Reuses the existing resident-welcome/invite plumbing rather than building a
 * second one: `ensureResidentSetupTokenForApplication` + the same
 * `/auth/resident-setup` link every applicant gets, and `deliverResidentWelcome`
 * for the email leg. The one new piece is the identity anchor: a minimal
 * `manager_application_records` row tagged `bookingResidency: true` so
 * `loadResidentPortalAccessState` (src/lib/resident-portal-access.ts) can grant
 * the booking unlock WITHOUT counting as a real submitted application — see
 * `readOwnedApplications`'s `bookingResidency` filter there, which is the one
 * place that tag is read for resident-facing access.
 *
 * Known gap: this row can still surface in the MANAGER's own Applications
 * list (bucket "pending") since that list reads `manager_application_records`
 * directly rather than through the resident access resolver. Filtering the
 * manager-facing list was out of scope for this pass.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  RESIDENT_WELCOME_EMAIL_RE,
  deliverResidentWelcome,
  type ResidentWelcomeActor,
} from "@/lib/resident-welcome.server";
import { ensureResidentSetupTokenForApplication } from "@/lib/auth/resident-setup-token";
import { residentAccountCreationUrl } from "@/lib/resident-welcome-email";
import { normalizeE164, formatSmsPhoneLabel } from "@/lib/phone-e164";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";

export type BookingResidentInviteInput = {
  blockId: string;
  propertyId: string;
  propertyLabel: string;
  residentName: string;
  /** "" is fine when a phone is given — at least one of the two is required. */
  residentEmail: string;
  /** E.164, or "" — at least one of email/phone is required. */
  residentPhone: string;
};

export type BookingResidentInviteResult =
  | { ok: true; channel: "sms" | "email"; attachedExisting: boolean; axisId: string; message: string }
  | { ok: false; error: string };

type ExistingRow = { id: string; row_data: unknown };

/** Find an existing identity under this manager by email (column) or phone (row_data) — never a duplicate. */
async function findExistingIdentity(
  db: SupabaseClient,
  managerUserId: string,
  email: string,
  phone: string,
): Promise<string | null> {
  if (email) {
    const { data } = await db
      .from("manager_application_records")
      .select("id")
      .eq("manager_user_id", managerUserId)
      .eq("resident_email", email)
      .limit(1);
    const hit = (data as { id: string }[] | null)?.[0]?.id;
    if (hit) return hit;
  }
  if (phone) {
    const { data } = await db
      .from("manager_application_records")
      .select("id, row_data")
      .eq("manager_user_id", managerUserId)
      .limit(500);
    const match = (data as ExistingRow[] | null ?? []).find((row) => {
      const rd = row.row_data && typeof row.row_data === "object" ? (row.row_data as Record<string, unknown>) : null;
      const rowPhone = rd && typeof rd.phone === "string" ? normalizeE164(rd.phone) : null;
      return Boolean(rowPhone && rowPhone === phone);
    });
    if (match) return match.id;
  }
  return null;
}

export async function sendBookingResidentInvite(
  db: SupabaseClient,
  actor: ResidentWelcomeActor & { managerName?: string },
  input: BookingResidentInviteInput,
): Promise<BookingResidentInviteResult> {
  const residentName = input.residentName.trim();
  const email = input.residentEmail.trim().toLowerCase();
  const phone = normalizeE164(input.residentPhone) ?? "";

  if (!residentName) return { ok: false, error: "A resident name is required." };
  if (!email && !phone) return { ok: false, error: "An email or phone is required to invite a resident." };
  if (email && !RESIDENT_WELCOME_EMAIL_RE.test(email)) {
    return { ok: false, error: "That email address doesn't look valid." };
  }

  const existingId = await findExistingIdentity(db, actor.userId, email, phone);
  const attachedExisting = Boolean(existingId);
  const axisId = normalizeApplicationAxisId(existingId ?? randomUUID());
  const iso = new Date().toISOString();

  /**
   * The account-setup link (`ensureResidentSetupTokenForApplication`, and
   * `/auth/resident-setup` itself) hard-requires a real "@"-shaped email on
   * the application row — there is no phone-only account-creation surface
   * anywhere in this codebase, and building one would be the second invite
   * path this module is explicitly not allowed to build. A phone-only new
   * resident still gets a synthetic login email in the SAME
   * `@import.proplane.local` placeholder family every imported/manual
   * resident without a real inbox already uses (`isPlaceholderResidentEmail`
   * in resident-welcome.server.ts) — it is prefilled and read-only on the
   * setup form, so the resident never has to type or even see it; only their
   * phone and password matter to them.
   */
  const loginEmail = email || `booking.${axisId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}@import.proplane.local`;

  if (!attachedExisting) {
    const row = {
      id: axisId,
      name: residentName,
      property: input.propertyLabel,
      stage: "Booking",
      bucket: "pending" as const,
      email: loginEmail,
      phone: phone || undefined,
      detail: `Booking · ${input.propertyLabel}`,
      propertyId: input.propertyId,
      assignedPropertyId: input.propertyId,
      manuallyAdded: true,
      // Read ONLY by resident-portal-access.ts to grant the booking unlock —
      // never treated as a real submitted application anywhere else that
      // reads this table (see the module doc above for the one known gap).
      bookingResidency: true,
      bookingBlockId: input.blockId,
    };
    const { error } = await db.from("manager_application_records").upsert(
      {
        id: axisId,
        manager_user_id: actor.userId,
        // The Supabase auth account this resident creates is keyed on
        // `loginEmail` (real, or the phone-only placeholder) — the column
        // every resident-facing lookup scopes on must agree.
        resident_email: loginEmail,
        row_data: sealApplicantRow(row, axisId, actor.userId),
        updated_at: iso,
      },
      { onConflict: "id" },
    );
    if (error) return { ok: false, error: error.message };
  } else {
    const { data: existingRow } = await db
      .from("manager_application_records")
      .select("row_data")
      .eq("id", axisId)
      .maybeSingle();
    const rd =
      existingRow?.row_data && typeof existingRow.row_data === "object"
        ? (existingRow.row_data as Record<string, unknown>)
        : {};
    await db
      .from("manager_application_records")
      .update({ row_data: { ...rd, bookingBlockId: input.blockId }, updated_at: iso })
      .eq("id", axisId)
      .eq("manager_user_id", actor.userId);
  }

  const ensured = await ensureResidentSetupTokenForApplication(db, axisId, { managerUserId: actor.userId });
  const setupToken = ensured.ok ? ensured.token : undefined;
  const signupUrl = residentAccountCreationUrl("", axisId, setupToken);
  const managerName = actor.managerName?.trim() || "Your property manager";

  if (phone) {
    const smsBody = attachedExisting
      ? `${residentName}, a booking at ${input.propertyLabel} was just added to your PropLane account. Finish your move-in details: ${signupUrl} — ${managerName}`
      : `${residentName}, your PropLane move-in at ${input.propertyLabel} is ready. Set up your account and finish your move-in details: ${signupUrl} — ${managerName}`;
    const sms = await enqueueOwnerSms(
      {
        managerUserId: actor.userId,
        actorUserId: actor.userId,
        recipientPhone: phone,
        recipientEmail: email || undefined,
        body: smsBody,
        sendClass: "transactional",
        purpose: "booking_resident_invite",
        counterpartyRole: "resident",
        dedupeKey: `booking_invite:${actor.userId}:${input.blockId}`,
      },
      db,
    );
    if (sms.ok) {
      const phoneLabel = formatSmsPhoneLabel(phone) ?? phone;
      return {
        ok: true,
        channel: "sms",
        attachedExisting,
        axisId,
        message: `Invite sent by text to ${phoneLabel}.`,
      };
    }
    // No usable work number, or the send failed — fall back to email below
    // rather than blocking the booking on it.
  }

  if (!email) {
    return {
      ok: false,
      error: "No work number is set up to text, and no email is on file — add one to invite this resident.",
    };
  }

  const welcome = await deliverResidentWelcome(db, actor, { to: email, residentName, axisId });
  if (!welcome.ok) return { ok: false, error: welcome.error };
  return {
    ok: true,
    channel: "email",
    attachedExisting,
    axisId,
    message: phone
      ? `No work number is set up to text — invite sent by email to ${email} instead.`
      : `Invite sent by email to ${email}.`,
  };
}
