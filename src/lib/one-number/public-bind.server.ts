import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { propertyBelongsToWorkspace } from "@/lib/one-number/link-destinations.server";
import { roleForLinkPurpose, sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import {
  createLinkSession,
  mintPhoneBoundLink,
  PhoneBoundLinkError,
} from "@/lib/one-number/links.server";
import {
  otpMessageBody,
  requestPhoneOtp,
  verifyPhoneOtp,
  type RequestOtpResult,
} from "@/lib/one-number/phone-otp.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { normalizeConsentPhone } from "@/lib/sms-consent";

/**
 * Public phone-bind: `/apply/<code>` and `/tour/<code>`, where <code> is an `sms_entry_codes` code
 * (the same one a prospect can text). The page asks for a phone, texts a code to THAT phone, and
 * once the code is entered the person is bound: a phone-bound link is minted for that phone, a
 * verified session is opened on it, and the activity lands in their thread for that workspace.
 *
 * Nothing here trusts the code to authorize anything beyond "start an application / tour at this
 * house": the entry code only names a workspace and a house, never a person.
 */

export type PublicBindKind = "apply" | "tour";

export type EntryCode = {
  code: string;
  workspaceId: string;
  ownerUserId: string;
  propertyId: string;
  label: string | null;
};

const CODE_PATTERN = /^[A-Za-z0-9]{3,16}$/;

export function isPublicBindKind(value: unknown): value is PublicBindKind {
  return value === "apply" || value === "tour";
}

/** Entry codes are stored upper-case and matched case-insensitively. Null for anything unusable. */
export async function lookupEntryCode(db: SupabaseClient, raw: unknown): Promise<EntryCode | null> {
  const code = String(raw ?? "").trim();
  if (!CODE_PATTERN.test(code)) return null;
  const { data, error } = await db
    .from("sms_entry_codes")
    .select("code, workspace_id, owner_user_id, property_id, label, active")
    .eq("code", code.toUpperCase())
    .eq("active", true)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const workspaceId = String(row.workspace_id ?? "").trim();
  const ownerUserId = String(row.owner_user_id ?? "").trim();
  const propertyId = String(row.property_id ?? "").trim();
  if (!workspaceId || !ownerUserId || !propertyId) return null;
  // The code's house must still belong to the code's workspace.
  if (!(await propertyBelongsToWorkspace(db, propertyId, workspaceId))) return null;
  return {
    code: String(row.code),
    workspaceId,
    ownerUserId,
    propertyId,
    label: row.label ? String(row.label).trim() || null : null,
  };
}

function subjectFor(entry: EntryCode, kind: PublicBindKind): string {
  return `${entry.code}:${kind}`;
}

/** The 10-digit key for a typed phone, or null when it is not a US number. */
export function publicBindPhoneKey(raw: unknown): string | null {
  const key = normalizeConsentPhone(String(raw ?? ""));
  return normalizeE164(key) && /^\d{10}$/.test(key) ? key : null;
}

export async function requestPublicBindCode(
  db: SupabaseClient,
  input: { entry: EntryCode; kind: PublicBindKind; phoneKey: string; now?: Date },
): Promise<RequestOtpResult> {
  const { entry, kind, phoneKey } = input;
  return requestPhoneOtp(db, {
    phoneKey,
    purpose: "public_bind",
    subjectId: subjectFor(entry, kind),
    now: input.now,
    send: (code, challengeId) =>
      sendWorkspacePhoneText(db, {
        workspaceId: entry.workspaceId,
        phoneKey,
        body: otpMessageBody(code),
        role: roleForLinkPurpose(kind === "apply" ? "application" : "tour"),
        idempotencyKey: `phone-code:${challengeId}`,
      }),
  });
}

export type PublicBindResult =
  | { ok: true; token: string; session: { token: string; expiresAt: Date; maxAgeSeconds: number } | null }
  | { ok: false; reason: "no_challenge" | "expired" | "locked" | "wrong_code" | "unavailable" };

/**
 * Check the code and bind. On success: a phone-bound link (application for `apply`, tour for
 * `tour`) for that phone and house, a verified session on it when the link needs one, and a note
 * on the person's thread. The note is best effort; the bind does not depend on it.
 */
export async function verifyPublicBind(
  db: SupabaseClient,
  input: { entry: EntryCode; kind: PublicBindKind; phoneKey: string; code: unknown; origin?: string; now?: Date },
): Promise<PublicBindResult> {
  const now = input.now ?? new Date();
  const verified = await verifyPhoneOtp(db, {
    phoneKey: input.phoneKey,
    purpose: "public_bind",
    subjectId: subjectFor(input.entry, input.kind),
    code: input.code,
    now,
  });
  if (!verified.ok) return verified;

  const purpose = input.kind === "apply" ? "application" : "tour";
  let minted;
  try {
    minted = await mintPhoneBoundLink(db, {
      phoneKey: input.phoneKey,
      workspaceId: input.entry.workspaceId,
      purpose,
      targetType: "listing",
      targetId: input.entry.propertyId,
      createdBy: null,
      origin: input.origin,
      now,
    });
  } catch (error) {
    if (error instanceof PhoneBoundLinkError) return { ok: false, reason: "unavailable" };
    throw error;
  }

  // The code they just entered is the proof: open the session now instead of asking twice.
  let session: Awaited<ReturnType<typeof createLinkSession>> = null;
  if (purpose === "application") {
    session = await createLinkSession(
      db,
      { id: minted.linkId, phoneKey: input.phoneKey, purpose, expiresAt: minted.expiresAt },
      now,
    );
    if (!session) return { ok: false, reason: "unavailable" };
  }

  await recordOpenedNote(db, input.entry, input.phoneKey, purpose, minted.linkId);
  return { ok: true, token: minted.token, session };
}

/** "Opened the application link" on the person's thread for this workspace. Never throws. */
async function recordOpenedNote(
  db: SupabaseClient,
  entry: EntryCode,
  phoneKey: string,
  purpose: "application" | "tour",
  linkId: string,
): Promise<void> {
  try {
    const e164 = normalizeE164(phoneKey);
    if (!e164) return;
    await logManagerSmsMessage(db, {
      managerUserId: entry.ownerUserId,
      residentPhone: e164,
      direction: "outbound",
      body: purpose === "application" ? "Opened the application link" : "Opened the tour link",
      toPhone: e164,
      messageSid: `phone-link-open:${linkId}`,
      source: "automated",
      counterpartyRole: "prospect",
    });
  } catch (error) {
    console.error("[phone-bound-link] could not record the opened note", error instanceof Error ? error.message : error);
  }
}
