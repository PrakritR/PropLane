import { NextRequest, NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { planTierCanHoldAddons } from "@/lib/plan-addons";
import { loadRentReportingAddonSettings } from "@/lib/rent-reporting/manager-settings.server";
import {
  loadRentReportingEnrollment,
  openRentReportingLegalName,
  startRentReportingConsent,
  stopRentReportingConsent,
} from "@/lib/rent-reporting/consent.server";
import {
  isRentReportingPartnerLive,
  RENT_REPORTING_BUREAUS_LABEL,
  RENT_REPORTING_COMING_SOON,
} from "@/lib/rent-reporting/partner";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

type ResidentTenancy = { managerUserId: string; propertyId: string; propertyLabel: string };

/**
 * The one active rent-paying tenancy for this resident (a signed lease with rent
 * charges under way). No active recurring rent profile means nothing to report yet —
 * the card stays hidden rather than offering to report a tenancy that has not started.
 */
async function loadResidentTenancy(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  residentUserId: string,
  residentEmail: string,
): Promise<ResidentTenancy | null> {
  let query = db
    .from("portal_recurring_rent_profile_records")
    .select("manager_user_id, property_id, row_data")
    .eq("active", true);
  query = residentUserId
    ? query.or(`resident_user_id.eq.${residentUserId},resident_email.eq.${residentEmail}`)
    : query.eq("resident_email", residentEmail);
  const { data, error } = await query.limit(1).maybeSingle();
  if (error || !data?.manager_user_id || !data?.property_id) return null;
  const rowData = (data.row_data ?? {}) as { propertyLabel?: string };
  return {
    managerUserId: String(data.manager_user_id),
    propertyId: String(data.property_id),
    propertyLabel: rowData.propertyLabel?.trim() || "your home",
  };
}

async function loadLatestSubmission(db: ReturnType<typeof createSupabaseServiceRoleClient>, reportingId: string) {
  const { data } = await db
    .from("rent_reporting_submissions")
    .select("period, status, sent_at")
    .eq("reporting_id", reportingId)
    .order("period", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { period: data.period as string, status: data.status as string, sentAt: (data.sent_at as string | null) ?? null };
}

async function requireResident(): Promise<{ db: ReturnType<typeof createSupabaseServiceRoleClient>; userId: string; email: string } | null> {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
  const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
  if (!isResident) return null;
  const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
  if (!email) return null;
  return { db, userId: user.id, email };
}

export async function GET() {
  const ctx = await requireResident();
  if (!ctx) return NextResponse.json({ error: "Residents only." }, { status: 403 });

  if (!isRentReportingPartnerLive()) {
    return NextResponse.json({ eligible: false, comingSoon: true }, { headers: NO_STORE });
  }

  const tenancy = await loadResidentTenancy(ctx.db, ctx.userId, ctx.email);
  if (!tenancy) return NextResponse.json({ eligible: false }, { headers: NO_STORE });

  const tierResult = await getEffectiveManagerSkuTier(tenancy.managerUserId);
  if (!tierResult.ok) return NextResponse.json({ error: tierResult.error }, { status: 503 });
  const planHoldsAddon = planTierCanHoldAddons(tierResult.tier);
  const addonSettings = planHoldsAddon
    ? await loadRentReportingAddonSettings(ctx.db, tenancy.managerUserId)
    : { enabled: false };
  const addonAvailable = planHoldsAddon && addonSettings.enabled;

  const enrollment = await loadRentReportingEnrollment(ctx.db, ctx.userId, tenancy.propertyId);
  const reportedAs =
    enrollment?.status === "active" ? await openRentReportingLegalName(ctx.db, enrollment) : null;
  const lastSubmission = enrollment ? await loadLatestSubmission(ctx.db, enrollment.id) : null;

  return NextResponse.json(
    {
      eligible: true,
      addonAvailable,
      upgradeRequired: !planHoldsAddon,
      status: enrollment?.status ?? "stopped",
      reportedAs: reportedAs ? `${reportedAs} · ${tenancy.propertyLabel}` : null,
      lastSubmission,
      bureaus: RENT_REPORTING_BUREAUS_LABEL,
    },
    { headers: NO_STORE },
  );
}

export async function PUT(req: NextRequest) {
  const ctx = await requireResident();
  if (!ctx) return NextResponse.json({ error: "Residents only." }, { status: 403 });

  const tenancy = await loadResidentTenancy(ctx.db, ctx.userId, ctx.email);
  if (!tenancy) return NextResponse.json({ error: "No active tenancy to report." }, { status: 400 });

  let body: { action?: unknown; legalName?: unknown; dob?: unknown; consent?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body.action === "stop") {
    try {
      const enrollment = await stopRentReportingConsent(ctx.db, { residentUserId: ctx.userId, propertyId: tenancy.propertyId });
      return NextResponse.json({ status: enrollment.status }, { headers: NO_STORE });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Could not stop rent reporting." }, { status: 400 });
    }
  }

  if (body.action !== "start") return NextResponse.json({ error: "Unknown action." }, { status: 400 });

  if (!isRentReportingPartnerLive()) {
    return NextResponse.json({ error: RENT_REPORTING_COMING_SOON }, { status: 403 });
  }

  const tierResult = await getEffectiveManagerSkuTier(tenancy.managerUserId);
  if (!tierResult.ok) return NextResponse.json({ error: tierResult.error }, { status: 503 });
  if (!planTierCanHoldAddons(tierResult.tier)) {
    return NextResponse.json({ error: "Rent reporting is not available on your property's plan." }, { status: 403 });
  }
  const addonSettings = await loadRentReportingAddonSettings(ctx.db, tenancy.managerUserId);
  if (!addonSettings.enabled) {
    return NextResponse.json({ error: "Your property manager has not turned on rent reporting." }, { status: 403 });
  }
  if (body.consent !== true) {
    return NextResponse.json({ error: "Consent is required to turn on rent reporting." }, { status: 400 });
  }

  try {
    const enrollment = await startRentReportingConsent(ctx.db, {
      residentUserId: ctx.userId,
      managerUserId: tenancy.managerUserId,
      propertyId: tenancy.propertyId,
      propertyLabel: tenancy.propertyLabel,
      legalName: String(body.legalName ?? ""),
      dob: String(body.dob ?? ""),
    });
    return NextResponse.json({ status: enrollment.status }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not start rent reporting." }, { status: 400 });
  }
}
