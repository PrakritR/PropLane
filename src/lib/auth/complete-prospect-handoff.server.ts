import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVE_PORTAL_COOKIE } from "@/lib/auth/portal-access";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import { resolveTrustedProspectContactEmail } from "@/lib/auth/prospect-contact-trust";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";
import { normalizeTourContactPhone } from "@/lib/tour-contact-quality";
import {
  linkAllTourInquiriesForEmail,
  linkTourInquiryToResident,
  loadTourInquiryById,
  reconcileProspectInboxThreadsForResident,
} from "@/lib/tour-resident-link.server";
import { NextResponse } from "next/server";

type Db = SupabaseClient;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export type CompleteProspectHandoffInput = {
  userId: string;
  /** Prospect form / tour contact email — the Communication identity. */
  email: string;
  /** Signed-in auth email when it differs from the prospect contact email (OAuth). */
  authEmail?: string;
  fullName?: string;
  phone?: string;
  tourInquiryId?: string;
  handoff?: "message";
  /** Property-scoped compose URL from the public message handoff (`next` query param). */
  nextPath?: string;
};

/** Safe post-signup destination for a message prospect handoff. */
export function prospectMessageHandoffRedirect(nextPath?: string): string {
  const trimmed = nextPath?.trim() ?? "";
  if (trimmed.startsWith("/") && !isUnsafeRedirectPath(trimmed)) {
    return trimmed;
  }
  return "/resident/communication/active";
}

export type CompleteProspectHandoffResult =
  | { ok: true; redirectTo: string }
  | { ok: false; status: number; error: string };

/**
 * After OAuth (or an existing session), provision the resident role and link tour /
 * message prospect activity using the contact details from the public handoff.
 */
export async function completeProspectHandoffForUser(
  db: Db,
  input: CompleteProspectHandoffInput,
): Promise<CompleteProspectHandoffResult> {
  const tourInquiryId = input.tourInquiryId?.trim() ?? "";
  const handoff = input.handoff === "message" ? "message" : "";
  if (!tourInquiryId && handoff !== "message") {
    return { ok: false, status: 400, error: "Missing prospect handoff." };
  }

  let inquiry: Record<string, unknown> | null = null;
  let inquiryEmail = "";
  if (tourInquiryId) {
    inquiry = await loadTourInquiryById(db, tourInquiryId);
    if (!inquiry) {
      return { ok: false, status: 400, error: "Could not create your account. Check your details and try again." };
    }
    inquiryEmail = textField(inquiry, "email").toLowerCase();
    if (!inquiryEmail) {
      return { ok: false, status: 400, error: "Could not create your account. Check your details and try again." };
    }
  }

  const trustedContact = resolveTrustedProspectContactEmail({
    authEmail: input.authEmail ?? input.email,
    requestedContactEmail: input.email,
    tourInquiryEmailVerified: Boolean(tourInquiryId && inquiryEmail),
    verifiedInquiryEmail: inquiryEmail || undefined,
  });
  if (!trustedContact.ok) {
    return { ok: false, status: 400, error: trustedContact.error };
  }
  const email = trustedContact.contactEmail;
  const authEmail = trustedContact.authEmail;

  const phone =
    normalizeTourContactPhone(input.phone ?? "") ??
    normalizeTourContactPhone(textField(inquiry, "phone")) ??
    "";
  if (tourInquiryId && !phone) {
    return { ok: false, status: 400, error: "Could not create your account. Check your details and try again." };
  }

  const fullName = input.fullName?.trim() || textField(inquiry, "name") || undefined;

  const provisioned = await provisionResidentAccountByEmail(db, {
    userId: input.userId,
    email,
    fullName,
    phone: phone || undefined,
    inheritFromApplication: false,
  });
  if (!provisioned.ok) {
    return { ok: false, status: provisioned.status, error: provisioned.error };
  }

  await ensureProfileRoleRow(db, input.userId, "resident");

  if (tourInquiryId) {
    const linkResult = await linkTourInquiryToResident(db, {
      userId: input.userId,
      inquiryId: tourInquiryId,
      email,
    });
    if (!linkResult.ok) {
      return { ok: false, status: linkResult.status, error: linkResult.error };
    }
    await linkAllTourInquiriesForEmail(db, { userId: input.userId, email });
    await reconcileProspectInboxThreadsForResident(db, {
      userId: input.userId,
      contactEmail: email,
      authEmail,
      phone,
    });
  } else {
    await reconcileProspectInboxThreadsForResident(db, {
      userId: input.userId,
      contactEmail: email,
      authEmail,
      phone,
    });
  }

  const redirectTo =
    handoff === "message" ? prospectMessageHandoffRedirect(input.nextPath) : "/resident/tour/pending";
  return { ok: true, redirectTo };
}

export function prospectHandoffSuccessResponse(redirectTo: string): NextResponse {
  const res = NextResponse.json({ ok: true, redirectTo });
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set(ACTIVE_PORTAL_COOKIE, "resident", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure,
  });
  return res;
}
