import { NextResponse, after } from "next/server";
import {
  consumeResidentSetupTokenOnApplication,
  findApplicationForResidentSetup,
  residentSetupIdFromUrlParams,
} from "@/lib/auth/resident-setup-token";
import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";
import { sendResidentPropLaneAssistantIntro } from "@/lib/claw-onboarding-sms.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normalizeE164 } from "@/lib/phone-e164";

export const runtime = "nodejs";

type Body = {
  email?: string;
  password?: string;
  fullName?: string;
  phone?: string;
  token?: string;
  axisId?: string;
};

/** Validate a resident setup link (token + axis id). */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token")?.trim() ?? "";
    const axisId = residentSetupIdFromUrlParams(url.searchParams);
    const db = createSupabaseServiceRoleClient();
    const lookup = await findApplicationForResidentSetup(db, { token, axisId });
    if (!lookup.ok) {
      return NextResponse.json({ error: lookup.error }, { status: lookup.status });
    }
    return NextResponse.json({
      ok: true,
      axisId: lookup.axisId,
      email: lookup.email,
      name: lookup.name,
      phone: lookup.phone,
      propertyId: lookup.propertyId,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not validate setup link." },
      { status: 500 },
    );
  }
}

/**
 * Create or link a resident account using a one-time setup token from the application email.
 * Generic resident signup without a token is rejected.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const rawPhone = typeof body.phone === "string" ? body.phone.trim() : "";
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const axisId = typeof body.axisId === "string" ? body.axisId.trim() : "";

    if (!token || !axisId) {
      return NextResponse.json(
        { error: "Resident accounts are created from the setup link in your application email." },
        { status: 403 },
      );
    }
    if (!email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }
    // Phone is required on resident setup so tenancy/notification texts reach the
    // resident. The setup form prefills it from the application, so a missing or
    // unparseable value here means the resident cleared it — reject rather than
    // silently drop it.
    const phone = normalizeE164(rawPhone);
    if (!phone) {
      return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient();
    const lookup = await findApplicationForResidentSetup(supabase, { token, axisId });
    if (!lookup.ok) {
      return NextResponse.json({ error: lookup.error }, { status: lookup.status });
    }
    if (lookup.email !== email) {
      return NextResponse.json(
        { error: "Use the same email address from your rental application." },
        { status: 403 },
      );
    }

    // A setup token can be delivered to a guest browser during draft autosave;
    // possession of it is not proof that the applicant owns the email address.
    // It must never be used to create a confirmed account or inherit a record.
    const auth = await createSupabaseServerClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user || user.email?.trim().toLowerCase() !== lookup.email || !user.email_confirmed_at) {
      return NextResponse.json({ error: "Verify your email and sign in before completing account setup.", code: "EMAIL_VERIFICATION_REQUIRED" }, { status: 403 });
    }

    const userId = user.id;

    const provisioned = await provisionResidentAccountByEmail(supabase, {
      userId,
      email,
      fullName: fullName || lookup.name,
      phone,
      // The one-time setup token proves email control — safe to inherit the
      // matching application's identity/approval (default-deny opt-in).
      inheritFromApplication: true,
    });
    if (!provisioned.ok) {
      return NextResponse.json({ error: provisioned.error }, { status: provisioned.status });
    }

    await supabase.from("profiles").update({ manager_id: lookup.axisId }).eq("id", userId);
    await consumeResidentSetupTokenOnApplication(supabase, lookup.row);

    // First-account PropLane messaging assistant intro (Claw/Twilio) when phone
    // is on file — deferred so a cold relay can't stall the signup response.
    const introUserId = userId;
    const introAxisId = lookup.axisId;
    const introManagerUserId = String(lookup.row.managerUserId ?? "").trim() || null;
    const introFallbackName = fullName || lookup.name || "Resident";
    after(async () => {
      try {
        const { data: profile } = await supabase
          .from("profiles")
          .select("phone, full_name")
          .eq("id", introUserId)
          .maybeSingle();
        const phone = String(profile?.phone ?? "").trim();
        if (phone) {
          const name = String(profile?.full_name ?? "").trim() || introFallbackName;
          await sendResidentPropLaneAssistantIntro({
            db: supabase,
            toPhone: phone,
            residentUserId: introUserId,
            residentEmail: email,
            managerUserId: introManagerUserId,
            name,
            axisId: introAxisId,
          });
        }
      } catch {
        /* non-critical */
      }
    });

    const propertyId = lookup.propertyId;
    const redirectTo = propertyId
      ? `/resident/applications?axis_id=${encodeURIComponent(lookup.axisId)}`
      : "/resident/applications";

    return NextResponse.json({
      ok: true,
      axisId: lookup.axisId,
      linkedApplication: true,
      redirectTo,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not create resident account.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
