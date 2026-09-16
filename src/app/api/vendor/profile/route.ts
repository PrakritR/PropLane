import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { track } from "@/lib/analytics/posthog";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { normalizeE164 } from "@/lib/twilio";
import { buildVendorAcceptedPaymentMethods } from "@/lib/vendor-payment-methods";
import { resolveOwnVendorRecord } from "@/lib/vendor-own-record";

export const runtime = "nodejs";

/** Resolves the signed-in vendor's own directory row — never trusts client input for the id/manager link. */
async function requireVendor(): Promise<
  | { ok: true; userId: string; db: ReturnType<typeof createSupabaseServiceRoleClient> }
  | { ok: false; response: NextResponse }
> {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };

  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (String(profile?.role ?? "").toLowerCase() !== "vendor") {
    return { ok: false, response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  }
  return { ok: true, userId: user.id, db };
}

export async function GET() {
  try {
    const auth = await requireVendor();
    if (!auth.ok) return auth.response;

    const [own, { data: profileRow }] = await Promise.all([
      resolveOwnVendorRecord(auth.db, auth.userId),
      auth.db.from("profiles").select("phone, preferred_language, sms_consent_at").eq("id", auth.userId).maybeSingle(),
    ]);
    return NextResponse.json({
      profile: own?.row ?? null,
      linked: own !== null,
      contact: {
        phone: (profileRow?.phone as string | null) ?? "",
        preferredLanguage: (profileRow?.preferred_language as string | null) ?? "",
        smsConsent: Boolean(profileRow?.sms_consent_at),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load vendor profile.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireVendor();
    if (!auth.ok) return auth.response;

    const own = await resolveOwnVendorRecord(auth.db, auth.userId);
    if (!own) {
      return NextResponse.json({ error: "No linked manager found for this vendor account." }, { status: 400 });
    }

    const body = (await req.json()) as {
      name?: string;
      phone?: string;
      email?: string;
      preferredLanguage?: string;
      smsConsent?: boolean;
      trades?: string[];
      insuranceProvider?: string;
      insurancePolicyNumber?: string;
      insuranceExpiresAt?: string;
      achPaymentsEnabled?: boolean;
      acceptedPaymentMethods?: "ach"[];
    };

    const achPaymentsEnabled =
      body.achPaymentsEnabled !== undefined ? body.achPaymentsEnabled : own.row.achPaymentsEnabled;
    // ACH through Stripe Connect is the only payout method (PLAN-0916), so the
    // stored list is derived from the toggle rather than trusted from the body.
    const acceptedPaymentMethods = buildVendorAcceptedPaymentMethods({ achPaymentsEnabled: Boolean(achPaymentsEnabled) });

    // Phone must normalize to E.164 (international allowed) when provided —
    // profiles.phone is what the SMS agent dials, so reject junk up front.
    let normalizedPhone: string | null | undefined;
    if (body.phone !== undefined) {
      const raw = body.phone.trim();
      normalizedPhone = raw ? normalizeE164(raw) : null;
      if (raw && !normalizedPhone) {
        return NextResponse.json(
          { error: "That phone number doesn't look valid. Include your area code, or a + country code." },
          { status: 400 },
        );
      }
    }

    const preferredLanguage =
      body.preferredLanguage !== undefined
        ? body.preferredLanguage === "es" || body.preferredLanguage === "en"
          ? body.preferredLanguage
          : ""
        : undefined;

    const nextRow: ManagerVendorRow = {
      ...own.row,
      id: own.id,
      managerUserId: own.managerUserId,
      name: body.name !== undefined ? body.name.trim() : own.row.name,
      phone: body.phone !== undefined ? body.phone.trim() : own.row.phone,
      preferredLanguage: preferredLanguage !== undefined ? preferredLanguage || undefined : own.row.preferredLanguage,
      email: body.email !== undefined ? body.email.trim().toLowerCase() : own.row.email,
      trades: Array.isArray(body.trades)
        ? [...new Set(body.trades.map((t) => t.trim()).filter(Boolean))]
        : own.row.trades,
      insuranceProvider: body.insuranceProvider !== undefined ? body.insuranceProvider.trim() : own.row.insuranceProvider,
      insurancePolicyNumber:
        body.insurancePolicyNumber !== undefined ? body.insurancePolicyNumber.trim() : own.row.insurancePolicyNumber,
      insuranceExpiresAt:
        body.insuranceExpiresAt !== undefined ? body.insuranceExpiresAt.trim() : own.row.insuranceExpiresAt,
      achPaymentsEnabled,
      acceptedPaymentMethods,
      updatedAt: new Date().toISOString(),
    };

    const { error } = await auth.db
      .from("manager_vendor_records")
      .update({ row_data: nextRow, updated_at: new Date().toISOString() })
      .eq("id", own.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Canonical contact fields live on profiles — the agent reads only these.
    // Consent is set/cleared by the vendor here; STOP opt-out is separate.
    const profilePatch: Record<string, unknown> = {};
    if (normalizedPhone !== undefined) profilePatch.phone = normalizedPhone;
    if (preferredLanguage !== undefined) profilePatch.preferred_language = preferredLanguage || null;
    if (body.smsConsent !== undefined) profilePatch.sms_consent_at = body.smsConsent ? new Date().toISOString() : null;
    if (Object.keys(profilePatch).length > 0) {
      const { error: profileError } = await auth.db.from("profiles").update(profilePatch).eq("id", auth.userId);
      if (profileError) return NextResponse.json({ error: profileError.message }, { status: 500 });
      track("vendor_contact_info_saved", auth.userId, {
        has_phone: Boolean(normalizedPhone ?? undefined),
        sms_consent: body.smsConsent === true,
        language: preferredLanguage || "unset",
      });
    }
    return NextResponse.json({ profile: nextRow });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save vendor profile.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
