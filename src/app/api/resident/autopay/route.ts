import { NextRequest, NextResponse } from "next/server";

import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getStripe } from "@/lib/stripe";
import { listResidentSavedPaymentMethods } from "@/lib/stripe-resident-customer";
import { isUnpaidHouseholdCharge, type HouseholdCharge } from "@/lib/household-charges";
import {
  autopayNextScheduledChargeLabel,
  loadResidentAutopaySettings,
  resolveResidentAutopayHousehold,
  saveResidentAutopaySettings,
} from "@/lib/resident-autopay.server";
import { loadWorkspacePaymentSettingsForProperty, workspaceAutopayEnabled } from "@/lib/workspace-payment-settings.server";
import { formatPacificDate } from "@/lib/pacific-time";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

async function requireResident() {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return null;

  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db
    .from("profiles")
    .select("email, role, manager_id, stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();
  const isResident = await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role });
  if (!isResident) return null;

  const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
  const managerId = String(profile?.manager_id ?? "").trim();
  if (!email || !managerId) return null;

  return { db, userId: user.id, email, managerId, stripeCustomerId: profile?.stripe_customer_id?.trim() || null };
}

function scheduledChargeLabel(charge: HouseholdCharge | null, runDaysBeforeDue: number): string | null {
  return autopayNextScheduledChargeLabel(charge, runDaysBeforeDue, (date) =>
    formatPacificDate(date, { month: "short", day: "numeric" }),
  );
}

/** The resident's most recent DECLINED autopay run, for the "could not pay" banner. Null once resolved (no failed row exists). */
async function loadLatestFailedRun(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  residentUserId: string,
): Promise<{ chargeId: string; chargeTitle: string; failureReason: string } | null> {
  const { data: runRow } = await db
    .from("resident_autopay_runs")
    .select("charge_id, failure_reason")
    .eq("resident_user_id", residentUserId)
    .eq("status", "failed")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!runRow?.charge_id) return null;

  const { data: chargeRow } = await db
    .from("portal_household_charge_records")
    .select("row_data")
    .eq("id", runRow.charge_id)
    .maybeSingle();
  const charge = chargeRow?.row_data as HouseholdCharge | null;
  // The charge already got paid another way (or was cancelled) since the
  // decline — nothing left to show a banner about.
  if (!charge || !isUnpaidHouseholdCharge(charge)) return null;

  return {
    chargeId: String(runRow.charge_id),
    chargeTitle: charge.title || "your charge",
    failureReason: String(runRow.failure_reason ?? "The payment was declined."),
  };
}

/** Optional `propertyId` (query on GET, body on PUT) names one of the resident's tenancies; absent, the resolver picks deterministically. */
function requestedPropertyId(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await requireResident();
    if (!ctx) return NextResponse.json({ error: "Residents only." }, { status: 403 });

    const propertyId = requestedPropertyId(req.nextUrl.searchParams.get("propertyId"));
    const household = await resolveResidentAutopayHousehold(ctx.db, {
      residentEmail: ctx.email,
      managerId: ctx.managerId,
      propertyId,
    });
    if (!household && propertyId) {
      return NextResponse.json({ error: "That home has no recurring charges to enroll." }, { status: 404 });
    }

    const stripe = getStripe();
    const savedMethods = ctx.stripeCustomerId ? await listResidentSavedPaymentMethods(stripe, ctx.stripeCustomerId) : [];
    const defaultMethod = savedMethods.find((m) => m.isDefault) ?? savedMethods[0] ?? null;

    if (!household) {
      return NextResponse.json({
        managerAllowsAutopay: true,
        enabled: false,
        hasSavedMethod: savedMethods.length > 0,
        savedMethods,
        defaultMethod,
        runDaysBeforeDue: 0,
        nextScheduledCharge: null,
        failedRun: null,
      });
    }

    const workspaceSettings = await loadWorkspacePaymentSettingsForProperty(ctx.db, ctx.managerId, household.propertyId);
    const managerAllowsAutopay = workspaceAutopayEnabled(workspaceSettings);
    const settings = await loadResidentAutopaySettings(ctx.db, ctx.userId, household.householdKey);
    const failedRun = await loadLatestFailedRun(ctx.db, ctx.userId);
    return NextResponse.json({
      propertyId: household.propertyId,
      managerAllowsAutopay,
      enabled: settings?.enabled ?? false,
      paymentMethodId: settings?.paymentMethodId ?? null,
      hasSavedMethod: savedMethods.length > 0,
      savedMethods,
      defaultMethod,
      runDaysBeforeDue: settings?.runDaysBeforeDue ?? 0,
      nextScheduledCharge:
        settings?.enabled && settings.paymentMethodId
          ? scheduledChargeLabel(household.nextCharge, settings.runDaysBeforeDue)
          : null,
      failedRun,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load autopay settings.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctx = await requireResident();
    if (!ctx) return NextResponse.json({ error: "Residents only." }, { status: 403 });

    const body = (await req.json().catch(() => ({}))) as {
      enabled?: boolean;
      paymentMethodId?: string | null;
      runDaysBeforeDue?: number;
      propertyId?: string | null;
    };

    const propertyId = requestedPropertyId(body.propertyId);
    const household = await resolveResidentAutopayHousehold(ctx.db, {
      residentEmail: ctx.email,
      managerId: ctx.managerId,
      propertyId,
    });
    if (!household) {
      return propertyId
        ? NextResponse.json({ error: "That home has no recurring charges to enroll." }, { status: 404 })
        : NextResponse.json({ error: "No recurring charges to enroll yet." }, { status: 422 });
    }

    const workspaceSettings = await loadWorkspacePaymentSettingsForProperty(ctx.db, ctx.managerId, household.propertyId);
    if (body.enabled && !workspaceAutopayEnabled(workspaceSettings)) {
      return NextResponse.json({ error: "Your property manager has turned off autopay." }, { status: 403 });
    }

    const enabled = body.enabled === true;
    let paymentMethodId: string | null = null;
    if (enabled) {
      if (!ctx.stripeCustomerId) {
        return NextResponse.json({ error: "Add a bank or card before turning on autopay." }, { status: 422 });
      }
      const stripe = getStripe();
      const methods = await listResidentSavedPaymentMethods(stripe, ctx.stripeCustomerId);
      const requested = typeof body.paymentMethodId === "string" ? body.paymentMethodId.trim() : "";
      // Re-verify the id actually belongs to this resident's Stripe customer —
      // an id in the request body is never authorization on its own. No id
      // named at all falls back to the resident's current default method.
      const match = requested
        ? methods.find((m) => m.id === requested)
        : methods.find((m) => m.isDefault) ?? methods[0];
      if (!match) {
        return NextResponse.json(
          { error: requested ? "That payment method was not found." : "Add a bank or card before turning on autopay." },
          { status: requested ? 404 : 422 },
        );
      }
      paymentMethodId = match.id;
    }

    const runDaysBeforeDue = Math.min(5, Math.max(0, Math.round(Number(body.runDaysBeforeDue ?? 0)) || 0));

    const saved = await saveResidentAutopaySettings(ctx.db, {
      residentUserId: ctx.userId,
      managerId: ctx.managerId,
      householdKey: household.householdKey,
      enabled,
      paymentMethodId,
      runDaysBeforeDue,
    });

    track("autopay_enable", ctx.userId, { enabled: saved.enabled, days_before: saved.runDaysBeforeDue });

    return NextResponse.json({
      propertyId: household.propertyId,
      enabled: saved.enabled,
      paymentMethodId: saved.paymentMethodId,
      runDaysBeforeDue: saved.runDaysBeforeDue,
      nextScheduledCharge:
        saved.enabled && saved.paymentMethodId ? scheduledChargeLabel(household.nextCharge, saved.runDaysBeforeDue) : null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save autopay settings.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
