import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import {
  completeProspectHandoffForUser,
  prospectHandoffSuccessResponse,
} from "@/lib/auth/complete-prospect-handoff.server";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { assertPasswordMatchesExistingAuthUser } from "@/lib/auth/verify-auth-password";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadTourInquiryById } from "@/lib/tour-resident-link.server";
import { normalizeTourContactPhone } from "@/lib/tour-contact-quality";

export const runtime = "nodejs";

const GENERIC_FAILURE = "Could not create your account. Check your details and try again.";

type Body = {
  email?: string;
  password?: string;
  fullName?: string;
  phone?: string;
  tourInquiryId?: string;
  handoff?: string;
  nextPath?: string;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function textField(row: Record<string, unknown> | null | undefined, key: string): string {
  const value = row?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Opt-in resident account creation from a tour booking handoff.
 * Rate-limited and does not reveal whether an email already has an account.
 */
export async function POST(req: Request) {
  try {
    if (!rateLimit(`tour-resident-register:${clientIpFrom(req)}`, 10, 60_000).ok) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
    }

    const body = (await req.json()) as Body;
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const tourInquiryId = typeof body.tourInquiryId === "string" ? body.tourInquiryId.trim() : "";
    const handoff = typeof body.handoff === "string" ? body.handoff.trim() : "";

    if (!email.includes("@") || password.length < 8) {
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 400 });
    }
    if (!tourInquiryId && handoff !== "message") {
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient();
    let inquiry: Record<string, unknown> | null = null;
    if (tourInquiryId) {
      inquiry = await loadTourInquiryById(supabase, tourInquiryId);
      if (!inquiry) {
        return NextResponse.json({ error: GENERIC_FAILURE }, { status: 400 });
      }
      const inquiryEmail = textField(inquiry, "email").toLowerCase();
      if (!inquiryEmail || inquiryEmail !== email) {
        return NextResponse.json({ error: GENERIC_FAILURE }, { status: 400 });
      }
    }

    const phone =
      normalizeTourContactPhone(typeof body.phone === "string" ? body.phone : "") ??
      normalizeTourContactPhone(textField(inquiry, "phone")) ??
      "";
    if (tourInquiryId && !phone) {
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 400 });
    }

    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: "resident", full_name: fullName || undefined },
    });

    let userId: string;

    if (createErr) {
      const exists =
        createErr.message.toLowerCase().includes("already") ||
        createErr.message.toLowerCase().includes("registered");
      if (!exists) {
        return NextResponse.json({ error: GENERIC_FAILURE }, { status: 400 });
      }
      const existingId = await findAuthUserIdByEmail(supabase, email);
      if (!existingId) {
        return NextResponse.json({ error: GENERIC_FAILURE }, { status: 400 });
      }
      const pwCheck = await assertPasswordMatchesExistingAuthUser(email, password);
      if (!pwCheck.ok) {
        return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
      }
      userId = existingId;
    } else {
      if (!created?.user?.id) {
        return NextResponse.json({ error: GENERIC_FAILURE }, { status: 500 });
      }
      userId = created.user.id;
    }

    const nextPath = typeof body.nextPath === "string" ? body.nextPath.trim() : "";

    const handoffResult = await completeProspectHandoffForUser(supabase, {
      userId,
      email,
      fullName: fullName || textField(inquiry, "name") || undefined,
      phone,
      tourInquiryId: tourInquiryId || undefined,
      handoff: handoff === "message" ? "message" : undefined,
      nextPath: nextPath || undefined,
    });
    if (!handoffResult.ok) {
      return NextResponse.json({ error: handoffResult.error }, { status: handoffResult.status });
    }

    track("resident_account_created", userId, {
      source: tourInquiryId ? "tour_booking" : "property_message",
      ...(tourInquiryId ? { inquiry_id: tourInquiryId } : {}),
    });

    return prospectHandoffSuccessResponse(handoffResult.redirectTo);
  } catch {
    return NextResponse.json({ error: GENERIC_FAILURE }, { status: 500 });
  }
}
